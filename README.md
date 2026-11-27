---
translations:
  zh-CN: README.zh-CN.md
---
# Kimi Request Guard

Validates requests for the Kimi series models before they reach a channel. It rejects parameters that the model does not accept, fills or converts the reasoning settings each model expects, and returns a message that names the offending field.

Without this plugin, a request with an unsupported value reaches the vendor and comes back as a generic `invalid request`. With it, the gateway answers HTTP 400 with error code `request_rejected` and a specific reason, and the request is not sent upstream or billed.

## Channel setup

- Install this plugin under **Request plugins**.
- Create an instance and keep it enabled.
- Bind the instance globally, to the groups that serve Kimi models, or to the Kimi channels.
- Use the instance's **Models** list if the same instance should only cover some of them.

The plugin needs no API key, upstream address, or channel type. It does not send requests upstream and does not change model prices or billing.

## Models

The plugin handles these model families and leaves every other model unchanged:

| Family | Models |
| --- | --- |
| K3 | `kimi-k3`, `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, and later `kimi-k3*` names |
| K2.6 | `kimi-k2.6` and `kimi-k2.6-*` names |
| K2.7 Code | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, and `kimi-k2.7-*` names |

The model is read from the upstream model when the channel maps it, otherwise from the model the client asked for. Matching ignores letter case.

## Endpoints

The plugin runs at the `ingress` stage and understands these protocol names:

| Protocol | Client paths |
| --- | --- |
| `openai` | `/v1/chat/completions` |
| `openai_responses` | `/v1/responses` |
| `claude` | `/v1/messages` |
| `gemini` | Gemini `generateContent` paths |

Other endpoints, such as embeddings or image generation, pass through unchanged.

## What is checked

### Sampling

For every Kimi family, `temperature`, `top_p`, `n`, `presence_penalty`, and `frequency_penalty` may only be omitted or set to the value the model accepts. `temperature` is fixed at `1`; `top_p` at `0.95`; `n` at `1`; both penalties at `0`. `kimi-k2.6` with `thinking.type` set to `disabled` accepts `temperature` `0.6` instead of `1`.

### Reasoning

K3 always thinks and uses the top-level reasoning effort. The plugin accepts `low`, `high`, and `max` and adds `max` when the client sets nothing.

- Chat Completions: `thinking.effort` is converted to `reasoning_effort`, and `thinking` is removed. A bare `reasoning_effort` is validated.
- Responses: `reasoning.effort` is validated and defaulted.
- Messages: `output_config.effort` is validated and defaulted.

`kimi-k2.6` and `kimi-k2.7-code` keep their own `thinking` object and reject `reasoning_effort`. `thinking.type` must be `enabled` or `disabled`, and `thinking.keep` must be `all` or null. `kimi-k2.7-code` only accepts `enabled`.

### Output limits

`max_completion_tokens`, `max_tokens`, `max_output_tokens`, and `maxOutputTokens` must be positive integers. K3 accepts up to `1048576`; the K2 families accept up to `262144`.

### Messages, media, and tools

- Message content must not be empty, and the message list must not be empty. A rejection names the message position and role, such as `messages[2] (user)`.
- An assistant message that carries `tool_calls` is the one exception. Kimi documents its `content` as an empty string, so a `null`, missing, or blank text-block content is rewritten to `""` and the message is kept. A long tool-call history is rewritten with one `messages` replacement, so the patch stays inside the gateway's 512-operation limit.
- Tool names must match `^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$` and must not repeat.
- `tool_calls` must be paired with the matching `tool` messages or output items.
- Tool and output JSON Schemas must not contain infinite recursion without a termination condition.
- `type` in a JSON Schema must be one of `null`, `boolean`, `object`, `array`, `number`, `integer`, `string`, or an array of those. Other spellings such as `int`, `bool`, `float`, or `String` are rejected with the path, because Kimi answers them with `response_format.json_schema is not a valid moonshot flavored json schema`.
- Images and videos must be base64 data URLs, uploaded file references (`ms://...`), or the media the gateway has already inlined. URL-formatted media and SVG images are rejected.
- `tool_choice` may be `auto`, `none`, or `required`. A function object is rejected because it conflicts with thinking. The K2 families reject `required`.
- Dynamic tools, declared as `tools` on a `system` message, are accepted on K3 only.

### Protocol specifics

- Chat Completions rejects parameters the models do not accept, such as `seed`, `logit_bias`, `parallel_tool_calls`, and `top_k`.
- Responses only supports `tool_choice` `auto`, accepts `function`, `namespace`, `custom` (`apply_patch` only), and `web_search` tools, and only supports `json_schema` output.
- Messages requires `max_tokens` and only supports the `custom` tool type with an object `input_schema`.
- Gemini validates `generationConfig`, function declarations, and `functionCall` / `functionResponse` pairing.

## Example

    curl https://gateway.example.com/v1/chat/completions \
      -H "Authorization: Bearer sk-..." \
      -H "Content-Type: application/json" \
      -d '{
        "model": "kimi-k3.1-pro",
        "messages": [{"role": "user", "content": "Hello"}],
        "reasoning_effort": "high"
      }'

A request with `"temperature": 0.7` is rejected before it reaches the channel:

    HTTP/1.1 400 Bad Request

    {"error":{"message":"temperature is fixed at 1 and cannot be modified. (code: kimi.invalid_request)","type":"request_rejected"}}

## Limits

- The plugin only checks requests it can parse as an object body. Form bodies and unsupported protocols pass through.
- The checks follow the Kimi contract as of this plugin version. If Kimi changes a parameter rule, upgrade the plugin to the latest version.
- The plugin never sends request data anywhere and keeps nothing between requests.
