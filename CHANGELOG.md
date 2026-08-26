# 变更记录

本项目遵循 Keep a Changelog 的组织方式。在正式发布版本前，所有用户可感知变化先记录在 `Unreleased`。

## Unreleased

### Added

- 建立 `AGENTS.md`，规定新窗口阅读顺序、架构约束、开发流程和 Definition of Done。
- 建立产品需求、系统架构、模型接入、开发规范、当前状态和模型评测文档。
- 建立 Taro 跨端、服务端统一 Model Provider、H5 匿名首版三项 ADR。
- 增加 EditorConfig、Prettier 和 Markdownlint 基础格式规范。
- 增加本地 Markdown 链接检查命令 `npm run check:docs`。
- 增加阿里云百炼万相 `wan2.7-image-pro` 参考图改款验证脚本。
- 增加火山方舟 Seedream 参考图改款验证脚本。
- 增加固定服装改款基准提示词。

### Security

- 模型 API Key 仅保存在被 Git 忽略的 `.env.local`。
- 明确禁止客户端、日志、文档和 Git 历史保存真实模型密钥。
- 记录公开部署前必须轮换开发期已展示 Key 的要求。
