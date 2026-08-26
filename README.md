# AI 服装设计与改款助手

一个面向服装设计师和服装档口的参考图改款产品。用户上传原款，说明必须保留的元素和目标风格，系统给出设计方向并生成可用于灵感评审或快速衍生的服装效果图。

## 当前阶段

项目处于正式应用开发前的工程初始化阶段：

- 阿里云百炼 `wan2.7-image-pro` 参考图改款链路已验证成功。
- 火山方舟 Seedream 调用脚本已完成，账号仍需开通目标模型。
- 正式 H5 尚未初始化。
- 已确认手机端 H5 优先，并为微信小程序保留跨端能力。

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
- [模型接入与选型](docs/ai-models.md)
- [开发规范](docs/development-guide.md)
- [当前状态](docs/current-status.md)
- [模型评测记录](docs/model-evaluation-log.md)
- [架构决策记录](docs/decisions/README.md)
- [版本变更](CHANGELOG.md)

新开发窗口首先阅读根目录的 `AGENTS.md`。

## 当前可运行的模型验证

运行环境需要 Node.js 20 或更高版本。

1. 将 `.env.example` 复制为 `.env.local`。
2. 填写相应平台的 API Key 和业务空间地址。
3. 运行同一张服装图的模型测试：

```bash
npm run test:wan -- /absolute/path/to/garment.jpg
npm run test:seedream -- /absolute/path/to/garment.jpg
```

固定测试提示词位于 `prompts/retro-workwear.txt`。生成结果保存在本地 `outputs/`，该目录不会提交到 Git。

## 安全说明

- `.env.local` 已被 Git 忽略。
- API Key 只能由服务端读取，禁止进入未来的 H5 或小程序代码。
- 当前开发阶段使用过的测试 Key 在公开部署前必须更换。
- 不得把用户上传图片、完整 Base64、签名下载地址或模型密钥写入日志和文档。
