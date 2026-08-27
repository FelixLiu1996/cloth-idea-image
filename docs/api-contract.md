# API 契约

当前 API 前缀为 `/api/v1`。服装分析采用同步请求；首次生成、再次生成和继续修改采用“创建任务 + 查询状态”的异步接口，并共享稳定错误结构。

## 健康检查

`GET /health`

返回服务状态、当前生图/分析 Provider、模型和是否已配置。响应不得包含 Key、Base URL 或其他密钥信息。

## 客户端能力

`GET /api/v1/capabilities`

返回支持的业务模式、改款幅度、图片类型、上传上限、默认输出数量、分析能力、结构版本、异步生图任务和结果迭代能力，可用于后续动态表单。

## 分析原款并创建设计方向

`POST /api/v1/analyses`

请求为 `multipart/form-data`，字段与下方创建改款的基础字段相同。客户端应发送独立的 `Idempotency-Key`；同一服务进程内重复提交相同键时不再次调用分析模型。

成功响应为 HTTP `201`。以下只展示顶层关键字段，完整 `analysis` 结构由 `garment-dna-v0.2` 约束：

```json
{
  "analysisId": "uuid",
  "status": "succeeded",
  "provider": "alibaba-qwen-vl",
  "model": "qwen3.7-plus",
  "durationMs": 42000,
  "evidenceSummary": {
    "accepted": 11,
    "needsReview": 3,
    "unknown": 2
  }
}
```

实际响应还包含 `analysis`：其中 `visualFacts` 为固定16项，`designDirections` 恰好包含3项，并提供 `recommendedDirectionId`。分析记录一小时有效；原图不落盘，只保存 SHA-256 用于生成时校验图片一致性。

## 创建改款

`POST /api/v1/generations`

请求类型为 `multipart/form-data`：

| 字段             | 类型 | 必填 | 说明                                           |
| ---------------- | ---- | ---- | ---------------------------------------------- |
| `sourceImage`    | 文件 | 是   | JPG、PNG 或 WEBP，最大10 MB                    |
| `mode`           | 文本 | 是   | `inspiration` 或 `quick-derivative`            |
| `preserveItems`  | 文本 | 是   | 逗号、顿号或换行分隔的硬性保留项，可为空字符串 |
| `changeRequest`  | 文本 | 是   | 2至1000字符的整体改款要求                      |
| `styleDirection` | 文本 | 是   | 2至500字符的目标风格                           |
| `intensity`      | 文本 | 是   | `low`、`medium` 或 `high`                      |
| `analysisId`     | 文本 | 否   | 分析接口返回的 UUID；与 `directionId` 同时提供 |
| `directionId`    | 文本 | 否   | `direction-1` 至 `direction-3`                 |
| `parentJobId`    | 文本 | 否   | 同方向再生成时提供上一张结果的 UUID            |

客户端应发送唯一的 `Idempotency-Key` 请求头。同一服务进程内再次提交相同键时返回同一任务的当前状态，不重复调用模型；同一键用于不同请求时返回冲突。

任务首次创建返回 HTTP `202`：

```json
{
  "jobId": "uuid",
  "status": "queued",
  "statusUrl": "http://127.0.0.1:3000/api/v1/generations/{jobId}",
  "createdAt": "2026-08-27T12:00:00.000Z",
  "updatedAt": "2026-08-27T12:00:00.000Z"
}
```

同一幂等键的重复提交返回 HTTP `200` 和同一任务的当前状态，状态可能已经是 `generating`、`succeeded` 或 `failed`。客户端拿到任务 ID 后查询状态，不需要在模型生成期间保持上传连接。

## 查询生图任务

`GET /api/v1/generations/:jobId`

排队和生成中的响应分别使用 `queued` 或 `generating`，并包含 `jobId`、`statusUrl`、`createdAt` 和 `updatedAt`。响应设置 `Cache-Control: no-store`。

成功时返回 HTTP `200` 和完整 `GenerationApiResponse`：

```json
{
  "jobId": "uuid",
  "status": "succeeded",
  "provider": "alibaba-qwen-image",
  "model": "qwen-image-2.0-pro-2026-06-22",
  "resultUrl": "http://127.0.0.1:3000/api/v1/assets/{jobId}/result.png",
  "summary": "快速衍生 · 保留 格纹袖口 · 复古工装",
  "durationMs": 17000,
  "strategy": "analyzed",
  "directionId": "direction-1",
  "directionName": "复古多口袋工装",
  "operation": "initial",
  "parentJobId": null,
  "revisionInstruction": null,
  "createdAt": "2026-08-26T12:00:00.000Z"
}
```

任务执行失败时状态查询仍返回 HTTP `200`，以便客户端稳定读取终态；业务错误保存在 `error` 字段中：

```json
{
  "jobId": "uuid",
  "status": "failed",
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "模型请求超时，请稍后重试。",
    "requestId": "req-1",
    "retryable": true
  },
  "createdAt": "2026-08-27T12:00:00.000Z",
  "updatedAt": "2026-08-27T12:01:30.000Z"
}
```

任务不存在或进程已重启时返回 `404 GENERATION_JOB_NOT_FOUND`。

同时提供 `analysisId` 和 `directionId` 时使用 `garment-analysis-v1` 确定性编译提示词。两者都不提供时使用 `garment-redesign-v1` 直接生成，响应的 `strategy` 为 `direct`，方向字段为 `null`。只提供其中一个会返回 `INVALID_GENERATION_REQUEST`。

同方向再次生成时，客户端重新上传原图并提供 `parentJobId`。服务端会校验父结果、原图哈希、输入要求和方向的请求指纹一致性；任务成功后 `operation` 为 `regenerate`。父结果不匹配时直接返回 `PARENT_GENERATION_MISMATCH`，不会创建任务或调用付费模型。

服务端开发默认生图 Provider 为 `alibaba-qwen-image`；可通过服务端配置显式切换为 `alibaba-wan`，API 响应结构保持不变。客户端不得直接指定模型或 Provider。

## 继续修改结果

`POST /api/v1/generations/:jobId/refinements`

请求类型为 `multipart/form-data`：

| 字段          | 类型 | 必填 | 说明                                       |
| ------------- | ---- | ---- | ------------------------------------------ |
| `sourceImage` | 文件 | 是   | 最初上传的商品原图，必须与当前生成分支一致 |
| `instruction` | 文本 | 是   | 本轮修改要求，2至500字符                   |

服务端先确认父结果仍然存在，再用保存的 SHA-256 校验重新上传的原图。以父任务保存的基础 Prompt 为起点，使用 `garment-iteration-v1` 确定性累计全部修改要求，并把本轮指令放在提示词前部。每轮都从最初商品图、选中方向和全部累计修改一次性重建结果，不把任何模型生成图继续作为像素编辑输入。原始保留项、证据门事实、选中方向和禁止项继续生效。单条父子分支最多连续修改5次，超过时返回 `REFINEMENT_LIMIT_REACHED`，避免提示词和付费调用无边界增长。

校验通过后首次返回 HTTP `202` 的任务摘要，客户端通过同一个 `GET /api/v1/generations/:jobId` 查询。成功终态为 `GenerationApiResponse`，其中 `operation` 为 `refine`，`parentJobId` 指向用户继续修改时看到的上一版，`revisionInstruction` 为本轮指令。父记录不存在时返回 `PARENT_GENERATION_NOT_FOUND`；父图片已经清理时返回 `PARENT_ASSET_EXPIRED`；上传图与分支原图不一致时返回 `REFINEMENT_IMAGE_MISMATCH`。

## 读取结果图

`GET /api/v1/assets/:jobId/:fileName`

只允许读取服务端生成的 `result.jpg`、`result.png` 或 `result.webp`。路径经过白名单校验，禁止任意文件访问。

## 错误结构

提交阶段的业务错误和同步分析 Provider 错误使用同一结构，不返回堆栈、内部路径或厂商原始响应。异步生图 Provider 错误使用相同结构嵌入任务的 `error` 字段：

```json
{
  "code": "PROVIDER_TIMEOUT",
  "message": "模型请求超时，请稍后重试。",
  "requestId": "req-1",
  "retryable": true
}
```

常见状态码：

- `400`：缺图或表单参数错误。
- `404`：分析已过期或方向不存在。
- `409`：当前原图与分析时不一致、父任务不匹配，或同一幂等键被用于不同请求。
- `410`：继续修改所需的父结果图片已经过期。
- `413`：图片超过10 MB。
- `415`：图片类型不支持。
- `422`：模型拒绝输入。
- `429`：模型限流。
- `502`：模型鉴权失败或响应异常。
- `503`：模型未配置或暂时不可用。
- `504`：模型调用超时。

## 当前限制

- 分析、任务和幂等结果保存在进程内，服务重启后不保留。
- 结果父子关系和迭代基础 Prompt 同样只保存在进程内；客户端版本历史仅存在于当前页面，刷新后丢失。
- 结果图保存在本地 `var/assets/`，未设置自动过期清理。
- 接口尚未加入登录、会话、IP限流和每日预算。
- 分析仍为同步请求，分析期间客户端需保持连接。
- 生图任务没有持久化队列、跨重启恢复、取消或后台 worker 租约；当前异步执行器仅适合本地和受控验证。
