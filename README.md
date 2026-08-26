# AI 服装设计与改款助手

一个面向服装设计师和服装档口的参考图改款产品。用户上传原款，说明必须保留的元素和目标风格，系统给出设计方向并生成可用于灵感评审或快速衍生的服装效果图。

## 当前阶段

证据门控的“先分析、选方向、再生图”本地代码链路已经完成：

- 阿里云百炼 `wan2.7-image-pro` 参考图改款链路已验证成功。
- 阿里云百炼 `qwen-image-2.0-pro-2026-06-22` 已作为可配置生图 Provider 完成3张固定样本真实测试。
- 阿里云百炼 `qwen3.7-plus` 已封装为服装视觉分析 Provider，使用原生严格 JSON Schema 输出 `garment-dna-v0.2`。
- 手机端 H5 已实现图片选择、两种业务模式、三个设计方向、方向选择、原图/结果对比、本次生成历史、同方向再生成、继续修改和下载。
- 同一套 Taro 客户端已经通过 H5 和微信小程序构建。
- Fastify 服务端已实现受控上传、分析/生成幂等、原图哈希匹配、万相调用、结果转存和稳定错误响应。
- 领域层只允许高置信度可见事实进入确定性提示词，并保留直接生成路径用于降级和 A/B。
- 领域规则、Provider 和服务端路由共有22项自动化测试。
- 火山方舟 Seedream 调用脚本已完成，账号仍需开通目标模型。

其中，3张固定样本已完成真实测试：直接生成3次成功；旧模型分析后生成2次成功；升级 `qwen3.7-plus` 后，同一3张样本均使用严格 JSON Schema 一次性分析成功，并分别完成万相与 Qwen Image 生图。两种新版首次生成链路技术成功率均为3/3；Qwen Image 在两张带商家型号的样本中0/2复现文字，优于万相的2/2，但默认分辨率较低且部分改款仍偏保守。结果迭代代码与模拟 Provider 集成测试已完成，尚未执行真实付费模型的连续修改测试；加上上线基础设施尚未补齐，当前仍不适合公开测试。

最新进度以 [当前状态](docs/current-status.md) 为准。

## 首版目标范围

本节描述首版计划达到的产品范围，不表示所有能力已经实现。当前实现、部分实现和待开发项以 [当前状态](docs/current-status.md) 为准。

- 灵感设计模式：帮助设计师探索多个设计方向。
- 快速衍生模式：帮助档口快速得到相对稳妥、可生产的改款。
- 上传一张服装原图。
- 填写保留项、改款目标和风格要求。
- 生成设计说明、结构改款清单和服装效果图。
- 本地版本支持继续修改、重新生成、方向间结果对比和下载；跨刷新历史与可恢复任务尚未实现。

首版不包含纸样、尺寸表、完整工艺单、3D 服装、在线支付和强制登录。

## 技术方向

- 客户端：Taro + React + TypeScript
- 首发平台：手机端 H5
- 后续平台：微信小程序
- 服务端：Node.js + TypeScript
- 模型层：统一 Provider 接口
- 视觉分析：阿里云百炼 Qwen VL
- 首发生图：阿里云百炼万相
- 候选模型：阿里云百炼 Qwen Image、火山方舟 Seedream

架构说明见 [系统架构](docs/architecture.md)。

## 文档入口

- [产品需求](docs/product-requirements.md)
- [系统架构](docs/architecture.md)
- [API 契约](docs/api-contract.md)
- [模型接入与选型](docs/ai-models.md)
- [开发规范](docs/development-guide.md)
- [当前状态](docs/current-status.md)
- [模型评测记录](docs/model-evaluation-log.md)
- [架构决策记录](docs/decisions/README.md)
- [版本变更](CHANGELOG.md)

新开发窗口首先阅读根目录的 `AGENTS.md`。

## 本地运行

运行环境需要 Node.js 20.17 或更高版本。

1. 将 `.env.example` 复制为 `.env.local`。
2. 填写 `DASHSCOPE_API_KEY`、`DASHSCOPE_API_BASE_URL` 和模型名。若未填写 `DASHSCOPE_COMPATIBLE_BASE_URL`，服务端会根据以 `/api/v1` 结尾的百炼地址推导 `/compatible-mode/v1`。
3. 安装依赖并分别启动 API 与 H5：

```bash
npm install
npm run dev:server
npm run dev:client
```

默认访问地址：

- H5：`http://127.0.0.1:10086`
- API 健康检查：`http://127.0.0.1:3000/health`

微信小程序构建：

```bash
npm run build:weapp
```

如需绕过应用单独验证模型，可运行：

```bash
npm run test:wan -- /absolute/path/to/garment.jpg
npm run test:seedream -- /absolute/path/to/garment.jpg
```

固定测试提示词位于 `prompts/retro-workwear.txt`。生成结果保存在本地 `outputs/`，该目录不会提交到 Git。

提交前运行完整检查：

```bash
npm run check
```

## 安全说明

- `.env.local` 已被 Git 忽略。
- API Key 只能由服务端读取，禁止进入未来的 H5 或小程序代码。
- H5 和小程序只调用本项目 API，不直接调用模型厂商。
- 当前开发阶段使用过的测试 Key 在公开部署前必须更换。
- 不得把用户上传图片、完整 Base64、签名下载地址或模型密钥写入日志和文档。
