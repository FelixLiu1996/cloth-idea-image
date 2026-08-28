# AI 服装设计与改款助手

一个面向服装设计师和服装档口的参考图改款产品。用户上传原款，说明必须保留的元素和目标风格，系统给出设计方向并生成可用于灵感评审或快速衍生的服装效果图。

## 当前阶段

证据门控的“先分析、选方向、再生图”本地代码链路已经完成：

- 阿里云百炼 `qwen-image-2.0-pro-2026-06-22` 已作为当前开发默认生图 Provider，并完成3张固定样本真实测试。
- 阿里云百炼 `wan2.7-image-pro` 参考图改款链路已验证成功，保留为可配置回退和 A/B 对照。
- 阿里云百炼 `qwen3.7-plus` 已封装为服装视觉分析 Provider，使用原生严格 JSON Schema 输出 `garment-dna-v0.2`。
- 手机端 H5 已实现图片选择、两种业务模式、三个设计方向、方向选择、原图/结果对比、本次生成历史、同方向再生成、继续修改和下载。
- 同一套 Taro 客户端已经通过 H5 和微信小程序构建。
- Fastify 服务端已实现受控上传、分析/生成幂等、原图哈希匹配、可查询的异步生图任务、统一 Provider 调用、结果转存和稳定错误响应。
- H5 在创建生图或继续修改任务后自动轮询状态，短暂网络错误不会重复创建付费任务；分析请求本轮仍为同步。
- 单机小范围试用支持可选访问码、进程内每日分析/生图额度、模型并发与生图启动间隔；访问码由使用者输入，不进入客户端构建产物。
- 本地生成图片可配置自动保留时长，默认关闭删除；任务和额度仍不跨服务重启保存。
- 领域层只允许高置信度可见事实进入确定性提示词，并保留直接生成路径用于降级和 A/B。
- 领域规则、Provider、客户端服务和服务端路由均有自动化测试覆盖。
- 火山方舟 Seedream 调用脚本已完成，账号仍需开通目标模型。

其中，3张固定样本已完成真实测试：直接生成3次成功；旧模型分析后生成2次成功；升级 `qwen3.7-plus` 后，同一3张样本均使用严格 JSON Schema 一次性分析成功，并分别完成万相与 Qwen Image 生图。两种新版首次生成链路技术成功率均为3/3；Qwen Image 在两张带商家型号的样本中0/2复现文字，优于万相的2/2，因此当前先作为开发默认模型，把完整链路搭稳，再用固定样本 A/B 优化模型选择。Qwen Image 默认分辨率较低且部分改款仍偏保守，默认选择不是最终定型。结果迭代测试发现，只要把任一 Qwen 生成图再次用于编辑，就会快速产生锐化、颗粒和色彩噪点，当前代码已改为每轮重新上传最初商品图，用选中方向和全部累计修改一次性重建；白色绗缝样本的聚焦调用和390×844真实 H5 refinement 路由均通过视觉与技术验收。现有 H5 业务链路可以用于个人或少量受邀者的单机试用，但仍没有业务数据库、正式对象存储、跨重启恢复、正式账号和内容安全，不适合公开传播。

下一轮受邀试用已调整为微信小程序体验版：保留现有 H5，新增独立 AppID、独立微信云开发环境、持久任务/幂等/额度、云存储和 OpenID 权限。当前已接入新 AppID、免费云环境初始化和 H5/微信业务网关边界；首个不调用模型的“OpenID → 白名单 → 云存储 → 云函数 → 云数据库 → 恢复 → 主动清理”探针已经在真实环境完整跑通，集合已设为仅管理员可访问，测试云文件和记录均已确认删除。共享 `application` 层已建立分析、任务、幂等、额度和资产仓储契约，Fastify 生图入口已经使用共享准入用例；微信云五类仓储、受控文件适配器以及受环境开关保护的 Fake Provider 业务动作已经部署，覆盖分析、生成、继续修改、状态轮询、重进恢复和同键重放。五张业务集合已创建并设为 `ADMINONLY`；微信开发者工具中的真实微信身份已经完成 Fake 分析、首次/再次生成、两阶段退出恢复、继续修改和精确清理。人为延长 Fake 调用触发30秒云函数超时后，任务在租约到期时稳定收敛为不可重试失败且执行次数仍为1，验证了 Provider 调用开始后不会自动二次执行。`cloud://` 结果下载和物理手机保存到系统相册均已通过。真实 Qwen 分析、确定性 Prompt Compiler、Qwen Image 首次生成与原图重建式继续修改现已接入同一微信云函数代码，并有自动化 Provider 契约测试；物理手机已经完成一次真实“分析 → 选方向 → 首次生成 → 原图重建式继续修改 → 云端转存与展示”，三次模型请求均首次成功且没有重复执行。个人使用阶段的云端用户与全局日上限现均为50次分析、50次生图；默认仓库配置和普通构建继续保持 Fake/HTTP 安全值。详见 [微信小程序体验版升级计划](docs/wechat-mini-program-trial-plan.md)。

最新进度以 [当前状态](docs/current-status.md) 为准。

## 首版目标范围

本节描述首版计划达到的产品范围，不表示所有能力已经实现。当前实现、部分实现和待开发项以 [当前状态](docs/current-status.md) 为准。

- 灵感设计模式：帮助设计师探索多个设计方向。
- 快速衍生模式：帮助档口快速得到相对稳妥、可生产的改款。
- 上传一张服装原图。
- 填写保留项、改款目标和风格要求。
- 生成设计说明、结构改款清单和服装效果图。
- 本地版本支持继续修改、重新生成、方向间结果对比和下载；生图任务可查询并由当前页面自动恢复轮询，但跨刷新历史和跨服务重启恢复尚未实现。

首版不包含纸样、尺寸表、完整工艺单、3D 服装、在线支付和强制登录。

## 技术方向

- 客户端：Taro + React + TypeScript
- 首发平台：手机端 H5
- 后续平台：微信小程序
- 服务端：Node.js + TypeScript
- 模型层：统一 Provider 接口
- 视觉分析：阿里云百炼 Qwen VL
- 当前默认生图：阿里云百炼 Qwen Image
- 回退与候选模型：阿里云百炼万相、火山方舟 Seedream

架构说明见 [系统架构](docs/architecture.md)。

## 文档入口

- [产品需求](docs/product-requirements.md)
- [系统架构](docs/architecture.md)
- [API 契约](docs/api-contract.md)
- [模型接入与选型](docs/ai-models.md)
- [开发规范](docs/development-guide.md)
- [单机受控试用](docs/controlled-trial.md)
- [线上产品、开源仓库与产品优化参考](docs/online-product-and-repository-research.md)
- [微信小程序体验版升级计划](docs/wechat-mini-program-trial-plan.md)
- [微信云开发无模型费用验证](docs/wechat-cloud-setup.md)
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

## 单机小范围试用

无需数据库即可启用受控试用。在 `.env.local` 中设置：

```dotenv
TRIAL_ACCESS_CODE=请替换为不易猜测的访问码
TRIAL_DAILY_ANALYSIS_LIMIT=20
TRIAL_DAILY_GENERATION_LIMIT=30
TRIAL_MAX_CONCURRENT_MODEL_REQUESTS=1
TRIAL_GENERATION_MIN_INTERVAL_MS=31000
ASSET_RETENTION_HOURS=0
```

- `TRIAL_ACCESS_CODE` 留空时不显示访问码输入框，适合仅在自己电脑使用；分享 H5 地址前必须设置。
- 每日额度、幂等记录和任务状态都在当前服务进程内，服务重启后重新计算。
- 生图间隔默认按当前 Qwen Image 测试账号约2 RPM保守设置；切换模型时按厂商额度调整。
- `ASSET_RETENTION_HOURS=0` 表示不自动删除本地生成图；共享试用时可以显式设置为 `720`，即保留30天。
- 访问码只是小范围费用保护，不是正式用户系统；结果图片 URL 仍依赖不可猜测的任务 UUID，不应公开转发。

完整边界见 [单机受控试用说明](docs/controlled-trial.md)。

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
- 试用访问码只由用户在页面输入并保存在当前设备，不写入 H5 或小程序构建产物。
- 当前开发阶段使用过的测试 Key 在公开部署前必须更换。
- 不得把用户上传图片、完整 Base64、签名下载地址或模型密钥写入日志和文档。
