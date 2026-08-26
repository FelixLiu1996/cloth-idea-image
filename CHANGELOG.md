# 变更记录

本项目遵循 Keep a Changelog 的组织方式。在正式发布版本前，所有用户可感知变化先记录在 `Unreleased`。

## Unreleased

### Added

- 增加 npm workspace、共享严格 TypeScript 配置、ESLint、Prettier、Vitest 和统一检查命令。
- 增加 Taro + React 手机端改款页面，支持灵感设计、快速衍生、原图选择、保留项、改款方向和幅度。
- 增加 H5 与微信小程序构建能力。
- 增加 Fastify 服务端及健康检查、能力查询、服装改款生成和结果文件接口。
- 增加统一领域协议、版本化服装改款提示词和生成摘要。
- 增加正式 Alibaba Wan Provider，包含超时、错误标准化和临时结果下载。
- 增加并发安全的生成幂等、本地结果转存、文件内容/大小校验和8项自动化测试。
- 增加当前 API 契约文档和 Fastify/npm workspace 架构决策记录。
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
- 模型调用只在服务端发生，客户端构建产物不包含 API Key。
- 服务端生产依赖通过 `npm audit --omit=dev` 检查，当前为0项已知漏洞。
- 明确禁止客户端、日志、文档和 Git 历史保存真实模型密钥。
- 记录公开部署前必须轮换开发期已展示 Key 的要求。
