# AI 服装设计与改款助手

一个面向服装设计师和服装档口的参考图改款产品。用户上传原款，说明必须保留的元素和目标风格，系统给出设计方向并生成可用于灵感评审或快速衍生的服装效果图。

## 当前阶段

第一条本地可用的正式应用链路已经完成：

- 阿里云百炼 `wan2.7-image-pro` 参考图改款链路已验证成功。
- 手机端 H5 已实现图片选择、两种业务模式、保留项、改款方向、幅度和结果展示。
- 同一套 Taro 客户端已经通过 H5 和微信小程序构建。
- Fastify 服务端已实现受控上传、参数校验、幂等、万相调用、结果转存和稳定错误响应。
- 领域规则、Provider 和服务端路由已有自动化测试。
- 火山方舟 Seedream 调用脚本已完成，账号仍需开通目标模型。

最新进度以 [当前状态](docs/current-status.md) 为准。

## 首版产品范围

- 灵感设计模式：帮助设计师探索多个设计方向。
- 快速衍生模式：帮助档口快速得到相对稳妥、可生产的改款。
- 上传一张服装原图。
- 填写保留项、改款目标和风格要求。
- 生成设计说明、结构改款清单和服装效果图。
- 支持继续修改、重新生成和下载。

首版不包含纸样、尺寸表、完整工艺单、3D 服装、在线支付和强制登录。

## 技术方向

- 客户端：Taro + React + TypeScript
- 首发平台：手机端 H5
- 后续平台：微信小程序
- 服务端：Node.js + TypeScript
- 模型层：统一 Provider 接口
- 首发模型：阿里云百炼万相
- 候选模型：火山方舟 Seedream

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
2. 填写 `DASHSCOPE_API_KEY`、`DASHSCOPE_API_BASE_URL` 和模型名。
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
