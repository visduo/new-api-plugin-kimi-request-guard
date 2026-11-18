---
changelogVersion: 1
plugin: "visduo_kimi-request-guard"
version: "1.0.0"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.0.0]

### Added

- Validate Kimi K3, K2.6, and K2.7 Code requests on the Chat Completions, Responses, Messages, and Gemini endpoints before they reach a channel.
- Reject unsupported sampling values, reasoning settings, output limits, tool definitions, and media formats with a message that names the offending field.
- Convert `thinking.effort` to `reasoning_effort` on K3 Chat Completions requests and default the reasoning effort to `max`.
