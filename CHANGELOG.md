# 变更记录

本项目遵循 Keep a Changelog 的组织方式。在正式发布版本前，所有用户可感知变化先记录在 `Unreleased`。

## Unreleased

### Changed

- 澄清目标需求、目标架构、当前实现和上线前硬门槛的区别，增加实施状态矩阵，避免将下载、历史、异步任务和删除能力误认为已经完成。
- 服装分析默认模型由 `qwen3-vl-plus` 升级为原生多模态 `qwen3.7-plus`，关闭思考模式并使用严格 JSON Schema。
- 强化 Qwen 服装分析提示词，明确忽略商家型号、水印和价格文字，要求所有用户可见内容使用简体中文。
- 分析结果先进行证据安全的确定性归一化；仍不符合结构时，在150秒总预算内执行一次不重传图片的定向文本修复，并汇总调用用量。
- Provider 结构校验失败时仅记录 Zod 错误码和字段路径，便于诊断且不记录原图或完整模型响应。
- 成功的分析和生图日志增加标准化用量字段，便于后续记录 token、图片数量和输出尺寸。

### Fixed

- 修复匿名 H5 上传仍默认携带凭据、导致跨端口 API 预检后不发送实际请求的问题，并将长耗时模型请求的客户端超时显式调整为 180 秒。

### Added

- 增加 npm workspace、共享严格 TypeScript 配置、ESLint、Prettier、Vitest 和统一检查命令。
- 增加 Taro + React 手机端改款页面，支持灵感设计、快速衍生、原图选择、保留项、改款方向和幅度。
- 增加 H5 与微信小程序构建能力。
- 增加 Fastify 服务端及健康检查、能力查询、服装改款生成和结果文件接口。
- 增加统一领域协议、版本化服装改款提示词和生成摘要。
- 增加正式 Alibaba Wan Provider，包含超时、错误标准化和临时结果下载。
- 增加可配置的 Alibaba Qwen Image Provider，支持 `qwen-image-2.0-pro-2026-06-22` 参考图编辑、独立负面提示和结果本地转存；默认生图 Provider 仍为万相。
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
- 增加 `garment-dna-v0.2` 严格结构、视觉事实证据等级、置信度门控和三个结构化设计方向。
- 增加 Alibaba Qwen VL 服装分析 Provider、确定性 Prompt Compiler 和分析结果一小时有效期。
- 增加“分析原款 → 选择方向 → 生成效果图”H5 流程，展示关键改款、推荐方向和生产风险。
- 增加 `/api/v1/analyses`，并允许生成接口通过 `analysisId` 与 `directionId` 使用选中方向。
- 保留直接生成作为显式降级与 A/B 对照，不会在分析后自动触发生图或自动重试付费请求。
- 自动化测试增加至17项，覆盖 Qwen 严格 Schema、结构归一化、单次修复上限、证据门、提示词编译和分析后生图闭环。

### Security

- 模型 API Key 仅保存在被 Git 忽略的 `.env.local`。
- 模型调用只在服务端发生，客户端构建产物不包含 API Key。
- 服务端生产依赖通过 `npm audit --omit=dev` 检查，当前为0项已知漏洞。
- 明确禁止客户端、日志、文档和 Git 历史保存真实模型密钥。
- 记录公开部署前必须轮换开发期已展示 Key 的要求。
