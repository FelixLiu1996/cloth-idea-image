# API 契约

当前 API 前缀为 `/api/v1`。首版采用同步单图生成，后续升级为异步任务时保留版本化路径和稳定错误结构。

## 健康检查

`GET /health`

返回服务状态、当前 Provider、模型和是否已配置。响应不得包含 Key、Base URL 或其他密钥信息。

## 客户端能力

`GET /api/v1/capabilities`

返回支持的业务模式、改款幅度、图片类型、上传上限和默认输出数量，可用于后续动态表单。

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

客户端应发送唯一的 `Idempotency-Key` 请求头。同一服务进程内再次提交相同键时返回第一次的成功结果，不重复调用模型。

成功响应为 HTTP `201`：

```json
{
  "jobId": "uuid",
  "status": "succeeded",
  "provider": "alibaba-wan",
  "model": "wan2.7-image-pro",
  "resultUrl": "http://127.0.0.1:3000/api/v1/assets/{jobId}/result.png",
  "summary": "快速衍生 · 保留 格纹袖口 · 复古工装",
  "durationMs": 17000
}
```

## 读取结果图

`GET /api/v1/assets/:jobId/:fileName`

只允许读取服务端生成的 `result.jpg`、`result.png` 或 `result.webp`。路径经过白名单校验，禁止任意文件访问。

## 错误结构

所有业务和 Provider 错误使用同一结构，不返回堆栈、内部路径或厂商原始响应：

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
- `413`：图片超过10 MB。
- `415`：图片类型不支持。
- `422`：模型拒绝输入。
- `429`：模型限流。
- `502`：模型鉴权失败或响应异常。
- `503`：模型未配置或暂时不可用。
- `504`：模型调用超时。

## 当前限制

- 任务和幂等结果保存在进程内，服务重启后不保留。
- 结果图保存在本地 `var/assets/`，未设置自动过期清理。
- 接口尚未加入登录、会话、IP限流和每日预算。
- 生成目前为同步请求；模型长耗时期间客户端需保持连接。
