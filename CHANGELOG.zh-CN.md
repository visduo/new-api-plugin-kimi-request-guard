---
changelogVersion: 1
plugin: "visduo_kimi-request-guard"
version: "1.1.3"
locale: "zh-CN"
---
# Changelog

## [1.1.3]

### Changed

- 在 Chat Completions、Responses、Messages 和 Gemini 接口上，正文为空的消息在发往 Kimi 之前就会被拒绝，错误信息会指出消息位置和角色。
- 长工具调用历史里的空正文改写合并成一次 `messages` 替换，几百条工具调用的请求也不会超出网关 512 条操作的限额。

### Fixed

- 不带 `tool_calls` 的 assistant 消息如果正文为空，不再透传到上游；此前 Kimi 会返回 `a message has empty content, please check the conversation history and retry`。
- 带 `tool_calls` 的 assistant 消息如果正文是 `null`、缺失或空白文本块，会改写为 `""`；客户端用 `content: null` 保存工具调用历史时不再被上游拒绝。
- 历史含内联媒体、改写操作超出网关限额时，返回明确的拒绝原因，不再以 `invalid_effect` 让实例失败。

## [1.1.0]

### Changed

- 插件列表中的名称改为 Kimi Request Guard。
