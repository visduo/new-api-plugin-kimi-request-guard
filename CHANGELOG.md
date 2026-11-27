---
changelogVersion: 1
plugin: "visduo_kimi-request-guard"
version: "1.1.4"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.1.4]

### Changed

- Reject an empty message content on Chat Completions, Responses, Messages, and Gemini before the request reaches Kimi, and name the message position and role in the error.
- Merge the empty-content rewrites of a long tool-call history into one `messages` replacement, so a request with hundreds of tool calls stays within the gateway's 512-operation limit.
- Validate JSON Schema `type` values against the Moonshot flavored schema subset, so a schema that Kimi would answer with `not a valid moonshot flavored json schema` is rejected locally with the offending path.

### Fixed

- Reject an assistant message with empty content that carries no `tool_calls` instead of passing it upstream, which Kimi answers with `a message has empty content, please check the conversation history and retry`.
- Rewrite `null`, missing, or blank text-block content on an assistant message that carries `tool_calls` to `""`, so a tool-call history built by a client that leaves `content: null` no longer fails upstream.
- Answer with a clear rejection instead of failing the instance with `invalid_effect` when a history with inline media needs more rewrite operations than the gateway accepts.
- Reject a JSON Schema property whose schema is not an object, which Kimi refuses with the same flavored schema error.
