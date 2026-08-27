# 微信云开发无模型费用验证

## 1. 目的与边界

本步骤只验证以下基础设施链路，不调用 Qwen、万相或其他付费模型：

```text
微信小程序
  → 获取微信身份上下文
  → 云存储上传临时图片
  → garment-api 云函数
  → infrastructure_probes 云数据库持久化
  → 重新读取
  → 删除云文件和数据库记录
```

对应探针代码、自动化测试和独立云环境验证均已完成。这不是完整服装改款云端链路。仓库后续已经增加分析、生成、任务轮询、持久额度和测试结果转存的 Fake Provider 代码，但尚未在真实环境部署或验收；真实 Qwen/生图模型仍未迁移。

## 2. 固定环境

- 小程序 AppID：`wx5baead52b4ba6dc1`
- 云环境名称：`cloud1`
- 云环境 ID：`cloud1-d1g87yl4k4cdf212b`
- 微信开发者工具导入目录：`apps/client`
- 云函数名称：`garment-api`

AppSecret 和模型 API Key 不需要填写到仓库、客户端或本文档。当前探针不需要配置任何模型密钥。

## 3. 构建并部署云函数

在仓库根目录执行：

```bash
npm install
npm run build:weapp
```

该命令会同时生成：

- 小程序产物：`apps/client/dist/`
- 云函数部署目录：`apps/client/cloudfunctions/garment-api/`

`cloudfunctions/` 是构建产物，已被 Git 忽略，每次构建会重新生成。生成的部署包固定 `wx-server-sdk@4.0.2`，并覆盖其中存在安全告警的传递依赖；根项目和云函数部署包均需保持生产依赖审计为0项漏洞。可复现检查：

```bash
npm audit --omit=dev
npm run audit:wechat-cloud
```

构建脚本会把 `@cloth-idea/domain` 等工作区代码内联到 `index.js`，并在产物仍残留未解析的 `@cloth-idea/*` 引用时直接失败，防止云端因缺少本地 workspace 包而无法启动。

推荐在仓库根目录通过 CloudBase CLI 部署，以确保首次创建就使用 `cloudbaserc.json` 中的 Node.js 20.19、30秒超时和256 MB内存：

```bash
npx --yes --package @cloudbase/cli@3.8.1 tcb fn deploy garment-api --json
```

也可以回到微信开发者工具并重新编译。如果左侧没有出现 `cloudfunctions/garment-api`，关闭后重新导入 `apps/client`。随后右键 `garment-api`，选择“上传并部署：云端安装依赖”。开发者工具首次创建函数时可能选择不同运行时；运行时不能通过普通配置更新，部署后必须在云控制台核对为 Node.js 20.19。超时设为30秒；本探针不会接近该时限。

仓库中的 `cloudbaserc.json` 是云函数运行参数的准确信源；通过开发者工具部署后也必须按其中配置核对真实环境。

## 4. 创建数据库集合

在当前独立云环境中创建两个集合：

- `trial_members`
- `infrastructure_probes`

两者均不允许小程序客户端直接读写，只允许云函数管理。当前按确定性文档 ID 查询，不需要额外索引。

云存储只用于本次受控探针。保持体验版只分发给开发者和少量体验成员，不开放公开访问；正式业务上传前还要继续收紧存储规则、限额和自动清理，不能把当前探针权限当成公开部署方案。

## 5. 加入首位体验成员

在微信开发者工具顶部“普通编译”下拉菜单中新增编译模式，启动页面填写：

```text
pages/cloud-diagnostics/index
```

首次进入页面时会显示16位“当前用户指纹”，此时“体验权限”应为“尚未加入 trial_members”。该指纹是 OpenID 的不可逆截断哈希，页面和日志不会返回原始 OpenID。

在 `trial_members` 集合中新建记录：

- 文档 ID：页面显示的16位用户指纹
- 字段 `active`：布尔值 `true`
- 字段 `label`：字符串，例如 `owner`

回到诊断页点击“刷新云端身份”，应显示“已授权”。不要把 AppSecret、模型 Key 或原始 OpenID写入该记录。

## 6. 执行并验收探针

1. 点击“选择一张测试图片”。
2. 点击“运行无模型费用探针”。
3. 页面应显示 `succeeded` 和32位探针任务 ID。
4. 点击“从数据库重新读取”，应返回同一任务 ID，不会重新上传或产生新记录。
5. 点击“删除云文件和探针记录”。
6. 在云控制台确认 `infrastructure_probes` 中对应记录已删除，云存储的对应临时文件也已删除。

上传路径会绑定当前用户指纹：

```text
garment-source-temp/{viewerFingerprint}/incoming/{idempotencyKey}.{ext}
```

云函数会再次校验用户白名单、路径归属、文件类型、大小和幂等键。相同幂等键和相同请求返回同一记录；相同键用于不同请求会返回稳定的 `IDEMPOTENCY_KEY_CONFLICT`。

## 7. 通过标准

- 未加入 `trial_members` 的账号不能创建探针。
- 页面和云函数响应不出现原始 OpenID、模型密钥、图片 Base64 或底层数据库错误。
- JPG、PNG 或 WEBP 小于等于10 MB的测试图可以上传。
- 云函数创建的记录可以跨页面请求重新读取。
- 清理动作同时删除云文件和数据库记录。
- 全过程没有调用任何付费模型。

如果任一步失败，保留页面显示的稳定错误码和云函数请求 ID；不要复制完整图片、Authorization 请求头或云端密钥到聊天和日志。

## 8. 当前真实环境验证记录

2026-08-27 在独立环境 `cloud1-d1g87yl4k4cdf212b` 完成以下验证，全程未调用模型：

- `garment-api` 以 Node.js 20.19、30秒超时和256 MB内存运行。
- `trial_members` 与 `infrastructure_probes` 已创建并设置为 `ADMINONLY`；小程序客户端不能直接读写。
- 云存储权限为 `PRIVATE`，测试图片仅上传者与管理员可访问。
- 首位体验成员以16位 OpenID 不可逆指纹加入白名单；数据库未保存原始 OpenID。
- 一张约92 KB的 JPG 已完成真实上传、云函数持久化和“从数据库重新读取”，探针状态为 `succeeded`。
- 已通过同一云函数主动删除测试云文件和探针记录；随后数据库按探针 ID 查询返回空，原云存储路径返回404。该删除不可恢复，当前测试环境未遗留这张图片或探针记录。

首次云端调用曾因构建产物残留 `require("@cloth-idea/domain")` 而在函数入口前失败；打包规则和构建期检查已经修复。函数重建后仍能读取原探针记录，证明记录保存在云数据库而不是函数实例内。

## 9. 下一轮 Fake Provider 业务验收（尚未执行）

当前仓库已经实现不调用模型的 Fake Provider 业务路径，但截至2026-08-27尚未部署到真实云环境。该路径只验证业务协议、持久任务、幂等、额度、结果转存和重进恢复；分析结果会明确显示“未调用视觉模型”，生成结果只是原图副本，不代表真实设计效果。

在真实环境验收前，先创建以下五张集合并全部设置为 `ADMINONLY`：

- `garment_analyses`
- `garment_assets`
- `generation_jobs`
- `idempotency_records`
- `trial_usage`

然后在 `garment-api` 云函数环境变量中设置：

```text
WECHAT_CLOUD_BUSINESS_PROVIDER=fake
TRIAL_DAILY_ANALYSIS_LIMIT=5
TRIAL_DAILY_GENERATION_LIMIT=10
TRIAL_GLOBAL_DAILY_ANALYSIS_LIMIT=100
TRIAL_GLOBAL_DAILY_GENERATION_LIMIT=200
ASSET_RETENTION_HOURS=72
```

`WECHAT_CLOUD_BUSINESS_PROVIDER` 未设置为 `fake` 时，业务动作会返回 `CLOUD_BACKEND_NOT_DEPLOYED`；该默认关闭行为用于避免尚未验收的云端路径被误用。Fake 验收不需要配置任何 Qwen、万相或其他模型 Key。

重新部署云函数后，用微信云网关构建小程序：

```bash
TARO_APP_GARMENT_GATEWAY_MODE=wechat-cloud npm run build:weapp
```

真机依次验证：

1. 上传原图并获得三个明确标记为 Fake 的设计方向。
2. 选择一个方向并生成；首次提交应创建持久任务，客户端随后查询到 `succeeded`。
3. 对结果提出一次继续修改；结果仍是原图副本，但必须保留父任务和修改指令元数据。
4. 在任务查询完成前退出并重新进入小程序，确认设备保存的 jobId 会继续查询，而不是重新提交。
5. 保存 `cloud://` 结果到相册，确认走微信云下载接口。
6. 检查同一请求的安全重试只产生一条幂等记录、一个任务和一次额度计数。

自动定时清理尚未接入。完成本轮真实验收后，应在云控制台仅针对本轮测试记录，删除五张业务集合中的测试文档，并根据 `garment_assets.fileId` 删除对应的 `garment-source-temp/` 和 `garment-results/` 测试文件；删除后再次确认文件与记录均不存在。不要在仍有其他体验数据时整表清空。清理执行结果应回写 [当前状态](current-status.md)。
