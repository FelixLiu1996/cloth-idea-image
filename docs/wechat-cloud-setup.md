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

对应探针代码、自动化测试和独立云环境验证均已完成。仓库后续已经增加分析、生成、任务轮询、持久额度和测试结果转存的 Fake Provider，并已在真实环境完成分析、首次生成和再次生成切片。真实 Qwen/生图 Provider 代码也已迁移、部署并通过付费真机核心链路验收；本节前半部分的探针仍只用于无模型费用地验证基础设施。

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

- 小程序产物：`apps/client/dist/weapp/`
- 云函数部署目录：`apps/client/cloudfunctions/garment-api/`

`cloudfunctions/` 是构建产物，已被 Git 忽略，每次构建会重新生成。生成的部署包固定 `wx-server-sdk@4.0.2`，并覆盖其中存在安全告警的传递依赖；根项目和云函数部署包均需保持生产依赖审计为0项漏洞。可复现检查：

```bash
npm audit --omit=dev
npm run audit:wechat-cloud
```

构建脚本会把 `@cloth-idea/domain` 等工作区代码内联到 `index.js`，并在产物仍残留未解析的 `@cloth-idea/*` 引用时直接失败，防止云端因缺少本地 workspace 包而无法启动。

推荐在仓库根目录通过 CloudBase CLI 部署，以确保首次创建就使用 `cloudbaserc.json` 中的 Node.js 20.19、180秒超时和256 MB内存：

```bash
npx --yes --package @cloudbase/cli@3.8.1 tcb fn deploy garment-api --json
```

如果函数已经切换为真实 Provider，后续更新业务代码必须优先只替换函数代码，避免把 `cloudbaserc.json` 的 Fake 安全默认值和低额度写回线上：

```bash
npm run build:wechat-cloud
npx --yes --package @cloudbase/cli@3.8.1 tcb fn code update garment-api \
  --dir apps/client/cloudfunctions/garment-api \
  --json
```

该命令不更新运行配置。首次创建函数、确实需要修改运行时或环境变量时，才使用完整部署或云控制台，并在操作后复核私密配置。

也可以回到微信开发者工具并重新编译。如果左侧没有出现 `cloudfunctions/garment-api`，关闭后重新导入 `apps/client`。随后右键 `garment-api`，选择“上传并部署：云端安装依赖”。开发者工具首次创建函数时可能选择不同运行时；运行时不能通过普通配置更新，部署后必须在云控制台核对为 Node.js 20.19。超时设为180秒；基础设施探针不会接近该时限，真实 Provider 仍有独立的150秒请求预算。

仓库中的 `cloudbaserc.json` 是云函数运行参数的准确信源；通过开发者工具部署后也必须按其中配置核对真实环境。

## 4. 创建数据库集合

在当前独立云环境中创建两个集合：

- `trial_members`
- `infrastructure_probes`

两者均不允许小程序客户端直接读写，只允许云函数管理。当前按确定性文档 ID 查询，不需要额外索引。

云存储只用于本次受控探针。保持体验版只分发给开发者和少量体验成员，不开放公开访问；正式业务上传前还要继续收紧存储规则、限额和自动清理，不能把当前探针权限当成公开部署方案。

## 5. 配置体验权限

云函数支持两种权限模式：

- `fingerprint-allowlist`：默认且失败关闭。每个用户的16位指纹必须存在于 `trial_members`。
- `wechat-experience`：只用于微信平台体验版的少量受邀测试。必须同时设置有效的 `WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL`；窗口内任何能以当前 AppID 打开小程序并取得 OpenID 的用户都通过应用层权限，窗口结束后自动恢复指纹白名单。

仓库的 `.env.example` 和 `cloudbaserc.json` 始终保留 `fingerprint-allowlist`。体验版直通依赖微信后台限制体验成员访问，云函数本身无法查询某个 OpenID 是否在平台体验成员列表中，因此不得在正式公开版本继续使用未到期的直通窗口。

指纹白名单模式的首位体验成员按以下步骤加入。

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

- 指纹白名单模式下，未加入 `trial_members` 的账号不能创建探针；体验直通窗口内则依赖微信平台体验成员分发边界。
- 页面和云函数响应不出现原始 OpenID、模型密钥、图片 Base64 或底层数据库错误。
- JPG、PNG 或 WEBP 小于等于10 MB的测试图可以上传。
- 云函数创建的记录可以跨页面请求重新读取。
- 清理动作同时删除云文件和数据库记录。
- 全过程没有调用任何付费模型。

如果任一步失败，保留页面显示的稳定错误码和云函数请求 ID；不要复制完整图片、Authorization 请求头或云端密钥到聊天和日志。

## 8. 当前真实环境验证记录

2026-08-27 在独立环境 `cloud1-d1g87yl4k4cdf212b` 完成以下验证，全程未调用模型：

- `garment-api` 首次探针验收时以 Node.js 20.19、30秒超时和256 MB内存运行；真实 Provider 代码迁移后已调整为180秒并重新部署。
- `trial_members` 与 `infrastructure_probes` 已创建并设置为 `ADMINONLY`；小程序客户端不能直接读写。
- 云存储权限为 `PRIVATE`，测试图片仅上传者与管理员可访问。
- 首位体验成员以16位 OpenID 不可逆指纹加入白名单；数据库未保存原始 OpenID。
- 一张约92 KB的 JPG 已完成真实上传、云函数持久化和“从数据库重新读取”，探针状态为 `succeeded`。
- 已通过同一云函数主动删除测试云文件和探针记录；随后数据库按探针 ID 查询返回空，原云存储路径返回404。该删除不可恢复，当前测试环境未遗留这张图片或探针记录。

首次云端调用曾因构建产物残留 `require("@cloth-idea/domain")` 而在函数入口前失败；打包规则和构建期检查已经修复。函数重建后仍能读取原探针记录，证明记录保存在云数据库而不是函数实例内。

## 9. Fake Provider 业务验收

当前仓库已经实现不调用模型的 Fake Provider 业务路径，并于2026-08-27部署到真实云环境。该路径只验证业务协议、持久任务、幂等、额度和结果转存；分析结果会明确显示“未调用视觉模型”，生成结果只是原图副本，不代表真实设计效果。

以下五张集合已经创建并全部设置为 `ADMINONLY`：

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
FAKE_GENERATION_DELAY_MS=15000
GENERATION_EXECUTION_LEASE_SECONDS=210
MAX_REFINEMENT_DEPTH=3
```

`WECHAT_CLOUD_BUSINESS_PROVIDER` 支持 `fake` 和 `alibaba-qwen`。未设置、设置为 `disabled`、配置值无效或真实模式缺少密钥/地址时，业务动作会返回 `CLOUD_BACKEND_NOT_DEPLOYED`；该默认关闭行为用于避免尚未验收的云端路径被误用。Fake 验收不需要配置任何 Qwen、万相或其他模型 Key。

`FAKE_GENERATION_DELAY_MS` 只用于受控 Fake 真机验收：创建动作先持久化任务并立即返回，第一次状态查询领取执行租约后等待指定时间再转存结果。当前测试环境设为15秒，便于在任务仍为 `generating` 时退出并验证重进恢复；切换真实 Provider 后该变量不会生效。210秒租约必须长于150秒 Provider预算和函数收尾时间，避免正常长请求被误判为可接管。

重新部署云函数后，用微信云网关构建小程序：

```bash
TARO_APP_GARMENT_GATEWAY_MODE=wechat-cloud npm run build:weapp
```

完整真机验收仍需依次验证：

1. 上传原图并获得三个明确标记为 Fake 的设计方向。
2. 选择一个方向并生成；首次提交应创建持久任务，客户端随后查询到 `succeeded`。
3. 对结果提出一次继续修改；结果仍是原图副本，但必须保留父任务和修改指令元数据。
4. 在任务查询完成前退出并重新进入小程序，确认设备保存的 jobId 会继续查询，而不是重新提交。
5. 保存 `cloud://` 结果到相册，确认走微信云下载接口。
6. 检查同一请求的安全重试只产生一条幂等记录、一个任务和一次额度计数。

### 9.1 已完成的真实环境记录

2026-08-27 已通过微信开发者工具中的真实微信身份完成以下无模型费用验证：

- 显式以 `wechat-cloud` 网关构建小程序，Fake 分析返回三个方向并在页面正确展示。
- 选择推荐方向后，首次生成与同方向再次生成均返回 `succeeded`；两条任务分别标记为 `initial` 和 `regenerate`，第二条任务正确保存第一条任务的 `parentJobId`。
- `garment_analyses`、`garment_assets`、`generation_jobs`、`idempotency_records` 和 `trial_usage` 均产生了可查询记录；结果文件真实转存到 `garment-results/`，Provider/模型分别为 `testing-fake` / `fake-image-copy-v1`。
- 真实运行发现并修复微信包携带 Zod 导致分析结果解析异常，以及 `wx-server-sdk@4.0.2` 上传成功但返回 `statusCode=-1` 被误判失败的问题；修复后分析与两次生成均成功。
- 本轮测试的7个云文件和21条业务记录已按精确路径与文档 ID 永久删除；复核五张业务集合均为0条，`trial_members` 仍为1条，未改变体验成员配置。

2026-08-28 继续使用微信开发者工具中的真实微信身份和官方自动化通道完成两阶段补充验收：创建动作先返回 `queued`，首次查询开始后重新进入首页，页面最终恢复同一个任务、清除设备待确认 jobId，并在本地原图临时文件丢失时正常展示云端结果。随后提交一条继续修改任务，约16.5秒后返回 `refine`，父任务和修改指令正确；同一请求重放仍返回同一个任务。`cloud://` 结果下载248281字节成功，但开发者工具模拟器的 `saveImageToPhotosAlbum` 在20秒内未返回。项目负责人随后改用物理手机执行保存操作并确认成功，因此相册保存已完成真机验收；未提供机型和系统版本，不在此推断。

该轮专用测试产生2条任务、2条幂等记录、4条资产记录和4个云文件；验收后均按精确 ID 永久删除。数据库复查三组记录均为空，云存储复查返回文件不存在；`trial_usage` 当天计数保留，避免通过测试清理重置预算。Fake Provider 的云端基础设施和真机交互闭环至此完成；该次验收发生时真实 Qwen/生图 Provider 尚未迁移，后续虽然代码迁移完成，仍不能用这次 Fake 记录替代真实模型验收。

同日还完成一次真实云函数中断边界验收：将 Fake Provider 延迟临时调为35秒，在30秒函数执行时限内启动任务，首次状态查询由平台以 `FUNCTIONS_TIME_LIMIT_EXCEEDED` 中断。数据库记录表明 Provider 调用已经开始且 `attempt=1`；租约到期后连续两次查询都返回同一 `GENERATION_EXECUTION_INTERRUPTED`，`retryable=false`，没有生成结果资产或结果文件。这验证了实例中断后不会自动执行第二次 Provider 调用。测试后已把延迟恢复为15秒并重新部署，`garment-api` 状态为 `Active`。

中断测试产生的1个源图、1条源资产、1条任务和1条幂等记录已按精确路径/ID永久删除并复核不存在。当天个人和全局生成额度均保留为3次。该结论只覆盖 Fake Provider 下的真实云函数、数据库和租约行为，不替代真实 Qwen/生图 Provider 验收。

每日自动清理现已接入并用专用过期资产完成真实验证。每轮交互测试结束仍应主动删除本轮精确记录和对应云文件，不要等待保留期结束，也不要在存在其他体验数据时整表清空。清理结果应回写 [当前状态](current-status.md)。

## 10. 执行租约和每日过期清理

2026-08-27 已把持久执行租约和 `garment-expired-data-cleanup` 定时触发器部署到同一 `garment-api` 云函数：

- Fake 生图创建动作只持久化任务和执行输入并立即返回 `queued`；第一次状态查询领取租约后才转存结果。该设计用于小程序退出恢复验收，不应被描述为正式消息队列。
- 同一生成任务只能持有一个有效执行租约，并发同键请求不会同时转存结果或调用 Provider。
- 模型调用前发生中断时，同一请求可在租约过期后接管；模型调用一旦开始，过期任务只会转成稳定失败，不自动重新调用模型。
- 任务查询会把“模型调用后中断且租约过期”的任务收敛为 `GENERATION_EXECUTION_INTERRUPTED`，避免永久停留在处理中。
- 每日清理先删除 `garment_assets.fileId` 指向的物理云文件，成功后才删除资产元数据；失败记录保留给下一次触发器重试。
- 同一轮还会清理过期的分析、生成任务和幂等记录。`trial_usage` 当前按日期保留，后续扩大试用前再增加独立保留期。

真实环境先完成一次空数据清理，随后上传一张专用验证文件并插入1条已过期的 `garment_assets` 记录。再次手动触发后，函数约778ms返回：发现1条过期资产、删除1个云文件、删除1条资产记录、失败数0。之后按精确文档 ID 查询数据库为空，原云存储路径返回404；该专用测试文件和记录已永久删除。共享文件仍有有效资产引用时不删除物理文件的保护由自动化测试覆盖。

## 11. 真实 Provider 的受预算验收

真实模式代码已复用与 Fastify 相同的 `AlibabaQwenProvider`、`AlibabaQwenImageProvider`、证据门和 Prompt Compiler。以下配置已在准备付费真机验收时完成，仓库仍保留 Fake 安全部署默认值。

先保持 Fake 配置完成构建、检查和代码部署。然后由项目负责人在微信云控制台的 `garment-api` 环境变量中手动增加或更新：

```text
WECHAT_CLOUD_BUSINESS_PROVIDER=alibaba-qwen
DASHSCOPE_API_KEY=<只在云控制台填写>
DASHSCOPE_API_BASE_URL=<百炼 API 地址>
DASHSCOPE_COMPATIBLE_BASE_URL=<兼容模式地址，可省略且由标准地址推导>
DASHSCOPE_VISION_MODEL=qwen3.7-plus
DASHSCOPE_IMAGE_MODEL=qwen-image-2.0-pro-2026-06-22
DASHSCOPE_ANALYSIS_TIMEOUT_MS=150000
DASHSCOPE_GENERATION_TIMEOUT_MS=150000
GENERATION_EXECUTION_LEASE_SECONDS=210
MAX_REFINEMENT_DEPTH=3
```

同时把用户和全局的分析/生图日额度设置为“当前已有计数 + 本轮最多调用数”，不要删除或调低既有 `trial_usage` 来绕过预算。本轮完整验收至少需要1次分析、1次首次生成和1次继续修改。Key 不得复制到 `.env.example`、`cloudbaserc.json`、聊天、截图或 Git。

`cloudbaserc.json` 有意保留 `fake` 作为安全部署默认值。真实模式启用后再次运行 CLI 部署可能把开关恢复为 Fake，并可能覆盖控制台环境变量；每次部署后必须在控制台复核 Provider 模式、私密变量、180秒函数上限和210秒租约。不要为了方便把真实 Key 写进部署配置。

真机按以下顺序验收：

1. 使用固定样本执行一次真实分析，确认 Provider/模型是 `alibaba-qwen-vl` / `qwen3.7-plus`，三个方向可选择且水印型号不作为服装事实。
2. 选择一个方向创建首次生图，确认先拿到同一任务 ID，最终结果由 `alibaba-qwen-image` 转存到 `garment-results/`。
3. 从最初商品图提交一次继续修改，确认任务标为 `refine`、父任务正确、结果不是对生成图做二次编辑。
4. 保存结果到物理手机相册，并复核分析、生图各自额度只按实际新请求增加；相同幂等请求不得产生第二次调用。
5. 记录耗时、厂商请求 ID、标准化用量和错误码；按精确 ID 清理本轮图片和业务记录，但保留 `trial_usage` 计数。

任一步失败都先保留稳定错误码、云函数请求 ID 和任务 ID，不要盲目重复点击。Provider 调用已经开始后的失败或未知状态不会自动重试；是否人工再次付费必须先核对数据库任务和厂商账单。

2026-08-28 经项目负责人明确授权，使用本机已有百炼配置更新云函数环境，过程中没有输出或提交密钥。真实环境已确认：Provider 模式为 `alibaba-qwen`，分析模型为 `qwen3.7-plus`，生图模型为 `qwen-image-2.0-pro-2026-06-22`，函数状态 `Active/Available`、上限180秒、租约210秒。当天已有1次分析和4次生图额度记录，用户与全局上限均收紧为2次分析和6次生图，因此仅剩完整验收所需的1次分析与2次生图。CLI 冷启动成功且只返回缺少微信身份的稳定错误，没有触发模型；小程序已用微信云网关重新构建。

同日项目负责人在物理手机完成受预算真实请求。分析记录 `8df2ab0c-1858-47a7-b8a6-057095be1ec2` 返回 `alibaba-qwen-vl` / `qwen3.7-plus`，约38.4秒，证据门汇总14项采纳、1项待复核、1项未知。首次生成任务 `54a70bd7-33f3-4bf3-b7a7-f3808c69d233` 返回 `alibaba-qwen-image` / `qwen-image-2.0-pro-2026-06-22`，约14.2秒；继续修改任务 `341a0c0f-a849-4694-858e-b753a0ce24ea` 使用同一模型，约14.5秒并正确引用首次生成父任务。两条任务均为 `attempt=1`，结果 PNG 分别为1,514,995和1,614,708字节，已经转存到云存储并在真机页面展示。分析、首次生成和继续修改各有唯一幂等记录，当天用户与全局计数从1/4准确增加到2/6，没有重复执行。日志检索服务当前未启用，因此没有为读取 Provider 请求 ID 额外开通日志产品；数据库任务、模型字段、执行次数、结果资产和页面结果已经形成相互一致的验收证据。

完整验收完成后，项目负责人要求个人使用阶段至少支持每日50次。云函数私密环境已将单用户与全局的分析、生图上限统一调整为50/50，现有 `trial_usage` 计数不重置；该数值是应用层费用保护，不是微信或阿里云赠送额度。当前日期键由 UTC ISO 日期生成，北京时间每天08:00切换到新日期；扩大体验成员范围前应改为明确的业务时区并重新拆分用户与全局预算。

少量体验成员试用阶段启用：

```text
WECHAT_CLOUD_TRIAL_ACCESS_MODE=wechat-experience
WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL=2026-09-30T15:59:59.000Z
```

截止时间对应北京时间2026-09-30 23:59:59。到期后现有 owner 的 `trial_members` 记录继续有效，其他体验用户需要重新配置窗口或加入指纹白名单。直通模式不绕过 OpenID 数据隔离、幂等、用户/全局额度、执行租约和72小时资产清理。

2026-08-28 已通过 CloudBase 的“仅更新函数代码”部署该能力，避免 `cloudbaserc.json` 的安全默认值覆盖线上真实配置。随后在服务端私密环境启用上述体验窗口并复核：`alibaba-qwen`、模型 Key、`qwen3.7-plus`、`qwen-image-2.0-pro-2026-06-22`、用户/全局50/50额度均保持不变；函数无微信上下文冷调用正常返回 `AUTH_WECHAT_CONTEXT_MISSING`。代码自动化已验证窗口内不查询指纹、到期回退以及错误配置失败关闭；首个不在 `trial_members` 的平台体验成员仍需完成一次真实账号验收。

同日，自由文字反馈、轻量费用提示和父任务原图复用变更也已使用 `tcb fn code update` 仅更新 `garment-api` 代码，没有应用 `cloudbaserc.json` 的 Fake 环境变量。部署后 CLI 无微信上下文冷调用在4毫秒内返回预期 `AUTH_WECHAT_CONTEXT_MISSING`，未触发模型；小程序产物已使用 `wechat-cloud` 网关和当前云环境重新构建。自动化已经覆盖父任务原图复用、唯一子任务和原图过期不占额度。

随后在真机只输入“上方拼接色变一下”并点击“生成修改后的下一版”，没有重新上传原图。任务 `6118a55f-9973-4547-ad69-214fcf599cff` 以 `refinement` / `refine` 成功，正确引用父任务 `a5becdb1-0c96-475d-a202-91873151e916`；父子执行输入的原图 SHA-256 完全一致。真实 Qwen Image 调用约13.9秒、`attempt=1`，只有1条绑定该子任务的幂等记录；同一准入时间点的用户/全局生图计数分别为10/13。真机展示版本2，用户确认结果没有异常。该记录验证了新交互、云端原图复用、父子任务和单次付费边界，不代表单个自然语言修改在所有服装上的视觉成功率。
