---
changelogVersion: 1
plugin: "visduo_kimi-request-guard"
version: "1.0.0"
locale: "zh-CN"
---
# Changelog

## [1.0.0]

### Added

- 在 Chat Completions、Responses、Messages 和 Gemini 接口上，于请求进入渠道前校验 Kimi K3、K2.6 和 K2.7 Code 的请求。
- 拒绝不支持的采样值、思考设置、输出上限、工具定义和媒体格式，并在提示中指明具体字段。
- 在 K3 的 Chat Completions 请求中把 `thinking.effort` 转换为 `reasoning_effort`，并把默认推理强度补为 `max`。
