# 系统架构

本文档同时描述当前本地实现与目标架构。第3、6、7节以当前代码为主；第4、5节包含当前边界和后续职责；第8至11节主要描述目标状态。功能是否已经交付以 [当前状态](current-status.md) 为准。

## 1. 架构目标

- H5 优先交付，同时降低后续微信小程序迁移成本。
- 模型供应商可替换，业务流程不依赖单一厂商。
- API Key 和用户图片只在受控服务端处理。
- 生图任务可追踪、可重试、可限额和可审计。

## 2. 总体结构

```text
Taro 客户端
├── H5 平台适配
└── 微信小程序平台适配
        │
        ▼
业务 API / 任务服务
├── 上传校验与资源存储
├── 证据门控与设计方向
├── 确定性 Prompt Compiler
├── 生图任务与幂等控制
└── 结果访问
        │
        ▼
Model Provider 层
├── Alibaba Qwen VL Analysis Provider
├── Alibaba Wan Provider
├── Alibaba Qwen Image Provider
└── Volcengine Seedream Provider
```

## 3. 当前仓库结构

当前正式应用采用以下结构：

```text
apps/
├── client/                 # Taro H5/微信小程序
└── server/                 # Node.js TypeScript API
packages/
├── domain/                 # 业务类型、规则和用例
└── model-providers/        # 万相与后续模型适配器
docs/
prompts/
scripts/
```

客户端内部的 `platform/` 隔离 Taro 图片选择能力，`services/` 负责本项目 API。共享 TypeScript、ESLint、Prettier 和 Vitest 配置当前保存在仓库根目录，达到多个实现后再提取独立配置包。

验证脚本保留在 `scripts/`，用于显式执行付费模型冒烟测试，不进入普通 CI。

## 4. 客户端边界

当前客户端已实现：

- 图片选择、压缩前预检和预览。
- 表单输入与校验。
- 同步分析，以及异步生图任务的加载、失败和结果状态。
- 创建生图任务后自动轮询，短暂查询网络错误不会创建新的付费任务。
- 服务端启用受控试用时显示访问码输入，并通过 Taro 平台存储保存在当前设备。
- 三个设计方向、生产风险和选中状态展示。
- 原图/上一版与当前结果对比、本次页面会话历史、同方向再生成和继续修改。
- 通过 Taro 平台适配层下载结果图。

目标客户端还应负责：

- 跨页面或跨重启的任务恢复与取消。
- 当前设备的匿名会话标识和近期任务。
- 平台分享入口。

客户端不得：

- 持有模型 API Key。
- 直接调用模型厂商接口。
- 将完整图片 Base64 写入本地日志或持久缓存。
- 在共享业务代码中直接调用浏览器或微信专属 API。

目标平台能力使用统一适配接口。当前已实现图片选择和结果保存适配；分享和会话接口尚未实现。完整接口草案例如：

```ts
interface PlatformAdapter {
  pickImage(): Promise<SelectedImage>;
  saveImage(url: string): Promise<void>;
  shareResult(input: ShareInput): Promise<void>;
  getSessionIdentity(): Promise<SessionIdentity>;
}
```

## 5. 服务端边界

当前服务端已实现：

- 接收受控上传并校验文件内容类型和大小。
- 构造版本化提示词。
- 调用分析和生图 Model Provider。
- 控制超时和进程内任务级幂等，不自动重复付费调用。
- 创建可查询的生图任务，并保存 `queued`、`generating`、`succeeded`、`failed` 状态。
- 可选校验共享试用访问码，并用进程内策略限制每日分析/生图额度、模型并发和生图启动间隔。
- 下载厂商临时结果并转存本地 `var/assets/`。
- 可选按保留时长清理本地 UUID 结果目录，默认关闭删除。
- 保存进程内父子生成关系，并支持从校验后的原图与累计指令重建继续修改结果。
- 返回稳定的业务错误码。

目标服务端还应负责：

- 保存可恢复、可查询、可删除和可过期的任务状态。
- 图片内容安全检查。
- 并发、用户/IP限流、额度、预算和告警。
- 将原图与结果图转存正式对象存储。

## 6. Model Provider 接口

业务层只依赖统一接口：

```ts
interface GarmentImageProvider {
  readonly provider: "alibaba-wan" | "alibaba-qwen-image" | "volcengine-seedream";
  readonly model: string;
  readonly configured: boolean;

  generateVariation(input: GarmentImageProviderInput): Promise<GarmentGenerationResult>;
}
```

生图 Provider 的统一输入包括：

- 原图受控文件引用。
- 领域层已编译的最终提示词。
- 输出数量。
- 提示词版本。

统一输出至少包括：

- Provider 和模型版本。
- 厂商请求 ID。
- 结果文件信息。
- 耗时和可获取的用量信息。
- 标准化错误。

视觉分析使用独立的 `GarmentAnalysisProvider`。它接收原图与用户简报，返回经过 Zod 校验的 `garment-dna-v0.2`；生图 Provider 不负责解释或重新组合这个结构。

## 7. 当前本地实现

当前纵向切片中分析仍为同步请求，首次生成、再次生成和继续修改采用可轮询的异步任务：

```text
POST /api/v1/analyses multipart
  → 参数与文件校验
  → Alibaba Qwen VL Provider
  → garment-dna-v0.2 结构校验
  → 可见事实证据门控与三个设计方向
  → 用户选择一个方向
  → 保存分析结构和原图 SHA-256（一小时有效）

POST /api/v1/generations multipart + analysisId + directionId
  → 验证同一原图 SHA-256
  → 确定性 Prompt Compiler
  → 创建进程内任务并立即返回 202 + jobId
  → Alibaba Qwen Image Provider（开发默认）
  → 下载厂商临时结果
  → var/assets/{jobId}/result.{ext}
  → 保存 succeeded 或 failed

GET /api/v1/generations/{jobId}
  → 返回 queued / generating / succeeded / failed
  → H5 自动轮询，成功后展示稳定 GenerationApiResponse

POST /api/v1/generations/{jobId}/refinements multipart
  → 重新上传原始商品图并校验分支 SHA-256
  → 确认父结果仍存在并读取原始基础 Prompt
  → 本轮指令前置并确定性追加累计修改指令
  → 每轮都以原始商品图为生成底图，一次性重算选中方向和全部累计修改
  → 创建进程内任务并返回 202 + 新 jobId
  → 使用 garment-iteration-v1 调用当前生图 Provider
  → 保存新结果及 parentJobId，客户端通过相同状态接口查询
```

- 分析记录、生图任务和幂等记录保存在服务进程内；服务重启后无法恢复。
- 每日额度和并发队列同样只在服务进程内，服务重启后重置；同一幂等任务不会重复占用额度。
- 结果图保存在被 Git 忽略的本地目录。
- 原图只在当前请求内存中传递，不在本地持久化。
- 分析记录只保存原图不可逆 SHA-256，不保存原图 Base64 或文件。
- `Idempotency-Key` 分别防止分析和生图重复计费。
- 生成幂等记录同时保存请求指纹和任务 ID；从排队到失败始终绑定同一任务。同一键用于不同请求时返回冲突，客户端提交传输失败时可用原键重试。
- 同方向再生成和继续修改都重新上传原图；继续修改先校验原图 SHA-256，再保留父子记录和累计指令。父结果用于确认用户当前版本仍存在和建立历史关系，不再作为下一代像素输入。
- 结果父子关系与基础 Prompt 仅保存在服务进程内；客户端历史仅保存在当前页面状态中。
- 不提供 `analysisId` 与 `directionId` 时仍走 `garment-redesign-v1` 直接生成，用于降级和 A/B 对照。
- 当前实现只用于本地开发和真实效果验证，不用于公开部署。
- 配置共享访问码和额度后，可供本人或少量明确受邀者在单机环境试用；访问码不等于正式身份认证，结果资源也没有用户级授权。

完整接口见 [API 契约](api-contract.md)。

## 8. 任务状态

当前已实现生图任务的核心四态，分析仍为同步请求，状态只保存在当前进程。上传前状态、取消、过期、删除、跨进程 worker 租约与重启恢复属于目标能力。

```text
draft
  → uploading
  → ready
  → queued
  → generating
  → succeeded
  → failed
  → expired/deleted
```

- 同一幂等键不能重复创建付费生图请求，当前进程内已实现。
- H5 只自动重试一次提交传输失败，并复用同一幂等键；Provider 错误不会自动重新生图。
- 任务查询的短暂网络失败可以自动恢复，不改变服务端任务。
- 厂商返回成功后必须立即转存临时结果 URL。
- 任务删除时同步安排原图和结果图删除，尚未实现。

## 9. 数据模型草案

本节尚未实现；当前没有数据库、匿名会话或任务历史。

- `sessions`：匿名或登录会话。
- `garment_projects`：一次服装改款项目。
- `source_images`：原始上传图及基础信息。
- `design_directions`：设计方向和约束。
- `generation_jobs`：模型请求、状态、耗时和错误。
- `generated_assets`：结果文件、模型和提示词版本。

数据库只保存必要的文件引用，不保存完整图片 Base64。

## 10. 安全与成本控制

本节同时包含当前规则和上线目标：Key 仅服务端读取、单次一张、Provider 超时、可选共享访问码、进程内全局日额度、并发和生图启动间隔已实现；用户/IP独立限流、持久预算、告警与完整日志脱敏审计尚未实现。

- Key 只通过服务端环境变量或密钥管理服务加载。
- 所有生成接口设置用户级和 IP 级限流。
- 默认一次生成一张，显式确认后才增加数量。
- 为模型调用设置超时、并发上限和每日预算告警。
- 单机试用的额度是全局进程内计数，重启即重置，不替代正式预算系统。
- 日志对 Authorization、图片地址签名参数和用户输入中的敏感信息脱敏。
- 公开上线前更换开发期已经展示过的所有 Key。

## 11. 部署阶段

### 阶段一：本地开发

- 客户端和服务端本地运行。
- 使用本地或开发对象存储。
- Qwen Image 作为阶段性默认 Provider，万相保留为显式回退和 A/B 对照。

### 阶段二：受控 H5 测试

- 当前可在单机持久磁盘上向少量受邀者发布带共享访问码的临时链接。
- 扩大范围前接入正式对象存储、数据库、监控和持久限额。
- 不开放支付和公开注册。

### 阶段三：公开 H5 与微信小程序

- 完成正式域名、备案、隐私文本和内容安全要求。
- 接入微信身份和平台分享能力。
- 根据真实评测确定主模型与回退策略。
