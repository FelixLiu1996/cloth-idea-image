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

对应代码和自动化测试已经完成，但在按本文部署并真机执行前，只能记为“已实现，待真实验证”。这不是完整服装改款云端链路，分析、生图、任务轮询、持久额度和模型结果转存仍未迁移。

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

回到微信开发者工具并重新编译。如果左侧没有出现 `cloudfunctions/garment-api`，关闭后重新导入 `apps/client`。随后右键 `garment-api`，选择“上传并部署：云端安装依赖”。云函数运行时使用 Node.js 20，超时先设为30秒；本探针不会接近该时限。

仓库同时提供 `cloudbaserc.json`，供后续 CloudBase CLI 部署使用；本轮可以只通过微信开发者工具部署。

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
