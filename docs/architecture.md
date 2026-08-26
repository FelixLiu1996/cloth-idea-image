# 系统架构

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
├── 匿名会话与用户
├── 上传与对象存储
├── 设计方向与提示词
├── 生图任务与额度控制
└── 结果与历史记录
        │
        ▼
Model Provider 层
├── Alibaba Wan Provider
└── Volcengine Seedream Provider
```

## 3. 计划中的仓库结构

正式应用初始化后采用以下结构：

```text
apps/
├── client/                 # Taro H5/微信小程序
└── server/                 # Node.js TypeScript API
packages/
├── domain/                 # 业务类型、规则和用例
├── model-providers/        # 万相、Seedream适配器
├── platform/               # 上传、分享、登录等平台适配
├── shared/                 # 通用类型、校验和错误码
└── config/                 # ESLint、TypeScript等共享配置
docs/
prompts/
scripts/
```

当前验证脚本保留在 `scripts/`，正式 Provider 完成并覆盖验证能力后再决定是否迁移或删除。

## 4. 客户端边界

客户端负责：

- 图片选择、压缩前预检和预览。
- 表单输入与校验。
- 任务状态展示和轮询。
- 当前设备的匿名会话标识。
- 下载、保存和平台分享入口。

客户端不得：

- 持有模型 API Key。
- 直接调用模型厂商接口。
- 将完整图片 Base64 写入本地日志或持久缓存。
- 在共享业务代码中直接调用浏览器或微信专属 API。

平台能力使用统一适配接口，例如：

```ts
interface PlatformAdapter {
  pickImage(): Promise<SelectedImage>;
  saveImage(url: string): Promise<void>;
  shareResult(input: ShareInput): Promise<void>;
  getSessionIdentity(): Promise<SessionIdentity>;
}
```

## 5. 服务端边界

服务端负责：

- 签发上传凭证或接收受控上传。
- 校验文件类型、尺寸、大小和内容风险。
- 保存任务与状态变更。
- 构造版本化提示词。
- 调用 Model Provider。
- 控制超时、重试、并发、额度和幂等。
- 下载厂商临时结果并转存对象存储。
- 返回稳定的业务错误码。

## 6. Model Provider 接口

业务层只依赖统一接口：

```ts
interface GarmentImageProvider {
  readonly provider: "alibaba-wan" | "volcengine-seedream";

  generateVariation(
    input: GarmentGenerationInput,
  ): Promise<GarmentGenerationResult>;
}
```

统一输入至少包括：

- 原图地址或受控文件引用。
- 设计方向和用户追加指令。
- 必须保留项。
- 改款幅度。
- 输出数量和尺寸。
- 提示词版本与幂等键。

统一输出至少包括：

- Provider 和模型版本。
- 厂商请求 ID。
- 结果文件信息。
- 耗时和可获取的用量信息。
- 标准化错误。

## 7. 任务状态

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

- 同一幂等键不能重复创建付费生图请求。
- 只有明确可重试的错误才能自动重试。
- 厂商返回成功后必须立即转存临时结果 URL。
- 任务删除时同步安排原图和结果图删除。

## 8. 数据模型草案

- `sessions`：匿名或登录会话。
- `garment_projects`：一次服装改款项目。
- `source_images`：原始上传图及基础信息。
- `design_directions`：设计方向和约束。
- `generation_jobs`：模型请求、状态、耗时和错误。
- `generated_assets`：结果文件、模型和提示词版本。

数据库只保存必要的文件引用，不保存完整图片 Base64。

## 9. 安全与成本控制

- Key 只通过服务端环境变量或密钥管理服务加载。
- 所有生成接口设置用户级和 IP 级限流。
- 默认一次生成一张，显式确认后才增加数量。
- 为模型调用设置超时、并发上限和每日预算告警。
- 日志对 Authorization、图片地址签名参数和用户输入中的敏感信息脱敏。
- 公开上线前更换开发期已经展示过的所有 Key。

## 10. 部署阶段

### 阶段一：本地开发

- 客户端和服务端本地运行。
- 使用本地或开发对象存储。
- 万相作为默认 Provider。

### 阶段二：受控 H5 测试

- 发布临时测试链接。
- 接入正式对象存储、监控和限额。
- 不开放支付和公开注册。

### 阶段三：公开 H5 与微信小程序

- 完成正式域名、备案、隐私文本和内容安全要求。
- 接入微信身份和平台分享能力。
- 根据真实评测确定主模型与回退策略。
