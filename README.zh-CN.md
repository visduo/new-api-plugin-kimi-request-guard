---
locale: zh-CN
---
# Kimi 请求校验

在请求进入渠道之前校验 Kimi 系列模型的请求。它会拒绝模型不接受的参数，补齐或转换各模型需要的思考设置，并在拒绝时指明具体字段。

没有这个插件时，带有不合法取值的请求会被送到上游，然后返回一句笼统的 `invalid request`。启用后，网关直接返回 HTTP 400、错误码 `request_rejected` 和具体原因，请求不会发往上游，也不会计费。

## 渠道设置

- 在 **请求插件** 中安装本插件。
- 创建一个实例并保持启用。
- 把实例绑定为全局、绑定到提供 Kimi 模型的分组，或绑定到 Kimi 渠道。
- 如果同一个实例只需要覆盖其中部分模型，用实例的 **模型** 列表缩小范围。

插件不需要 API Key、上游地址或渠道类型。它不会向上游发送请求，也不会改变模型价格或计费。

## 模型

插件处理以下模型系列，其余模型原样放行：

| 系列 | 模型 |
| --- | --- |
| K3 | `kimi-k3`、`kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`，以及后续的 `kimi-k3*` 名称 |
| K2.6 | `kimi-k2.6` 和 `kimi-k2.6-*` 名称 |
| K2.7 Code | `kimi-k2.7-code`、`kimi-k2.7-code-highspeed` 和 `kimi-k2.7-*` 名称 |

渠道做了模型映射时按上游模型名判断，否则按客户端请求的模型名判断。匹配不区分大小写。

## 接口

插件在 `ingress` 阶段运行，识别以下协议名：

| 协议 | 客户端路径 |
| --- | --- |
| `openai` | `/v1/chat/completions` |
| `openai_responses` | `/v1/responses` |
| `claude` | `/v1/messages` |
| `gemini` | Gemini 的 `generateContent` 路径 |

其它接口，例如嵌入或图片生成，原样放行。

## 校验内容

### 采样参数

所有 Kimi 系列都只能省略 `temperature`、`top_p`、`n`、`presence_penalty`、`frequency_penalty`，或把它们设为模型接受的固定值：`temperature` 为 `1`，`top_p` 为 `0.95`，`n` 为 `1`，两个惩罚项为 `0`。`kimi-k2.6` 在 `thinking.type` 为 `disabled` 时，`temperature` 接受 `0.6` 而不是 `1`。

### 思考设置

K3 始终思考，使用顶层的推理强度。插件接受 `low`、`high`、`max`，客户端不传时补 `max`。

- Chat Completions：把 `thinking.effort` 转换成 `reasoning_effort`，并删除 `thinking`；直接传入的 `reasoning_effort` 也会校验。
- Responses：校验并补齐 `reasoning.effort`。
- Messages：校验并补齐 `output_config.effort`。

`kimi-k2.6` 和 `kimi-k2.7-code` 保留自己的 `thinking` 对象，并拒绝 `reasoning_effort`。`thinking.type` 只能是 `enabled` 或 `disabled`，`thinking.keep` 只能是 `all` 或 null。`kimi-k2.7-code` 只接受 `enabled`。

### 输出上限

`max_completion_tokens`、`max_tokens`、`max_output_tokens`、`maxOutputTokens` 必须是正整数。K3 最大 `1048576`，K2 系列最大 `262144`。

### 消息、媒体与工具

- 消息列表不能为空，消息正文也不能为空。
- 工具名必须匹配 `^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$`，且不能重名。
- `tool_calls` 必须与对应的 `tool` 消息或输出项一一配对。
- 工具和输出的 JSON Schema 不能包含没有终止条件的无限递归。
- 图片和视频必须是 base64 data URL、已上传的文件引用（`ms://...`），或网关已经内联的媒体。URL 形式的媒体和 SVG 图片会被拒绝。
- `tool_choice` 可以是 `auto`、`none` 或 `required`。指定具体函数的对象会与思考冲突，因此被拒绝；K2 系列不接受 `required`。
- 在 `system` 消息里声明 `tools` 的动态工具只有 K3 支持。

### 各协议细节

- Chat Completions 拒绝模型不接受的参数，例如 `seed`、`logit_bias`、`parallel_tool_calls`、`top_k`。
- Responses 只支持 `tool_choice` 为 `auto`，接受 `function`、`namespace`、`custom`（仅 `apply_patch`）和 `web_search` 工具，输出格式只支持 `json_schema`。
- Messages 必须提供 `max_tokens`，工具类型只支持 `custom`，且 `input_schema` 必须是对象。
- Gemini 校验 `generationConfig`、函数声明以及 `functionCall` / `functionResponse` 的配对。

## 示例

    curl https://gateway.example.com/v1/chat/completions \
      -H "Authorization: Bearer sk-..." \
      -H "Content-Type: application/json" \
      -d '{
        "model": "kimi-k3.1-pro",
        "messages": [{"role": "user", "content": "你好"}],
        "reasoning_effort": "high"
      }'

带 `"temperature": 0.7` 的请求会在进入渠道前被拒绝：

    HTTP/1.1 400 Bad Request

    {"error":{"message":"temperature is fixed at 1 and cannot be modified. (code: kimi.invalid_request)","type":"request_rejected"}}

## 限制

- 插件只校验能按对象解析的请求体。表单请求体和不支持的协议原样放行。
- 校验规则以本插件版本对应的 Kimi 接口约定为准。如果 Kimi 调整了参数规则，请把插件升级到最新版本。
- 插件不会把请求数据发送到任何地方，也不会在请求之间保留数据。
