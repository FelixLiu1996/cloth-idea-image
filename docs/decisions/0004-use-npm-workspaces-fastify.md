# 0004：使用 npm workspaces 与 Fastify 组织首版应用

- 状态：Accepted
- 日期：2026-08-26

## 背景

客户端、服务端、领域规则和模型适配器需要独立边界，同时首版团队规模小，不适合引入复杂的 monorepo 编排系统。服务端需要可靠处理 multipart 上传、稳定错误和后续异步任务扩展。

## 决定

- 使用 npm workspaces 管理 `apps/*` 与 `packages/*`。
- 使用 `apps/client` 存放 Taro H5/微信小程序客户端。
- 使用 `apps/server` 存放 Fastify + TypeScript API。
- 使用 `packages/domain` 保存无平台依赖的业务协议和规则。
- 使用 `packages/model-providers` 隔离模型厂商协议。
- 首条纵向切片使用同步 API 和本地结果存储；它们是本地验证实现，不是公开部署方案。

## 原因

- npm workspaces 已满足依赖共享、锁文件和统一命令需求，额外工具收益有限。
- Fastify 对 TypeScript、插件、multipart、测试注入和错误处理有成熟支持。
- 独立共享包可以防止页面、路由和模型协议互相耦合。
- 同步切片能最早验证真实模型效果，同时 Provider 接口允许后续迁移异步队列。

## 影响

- 所有工作区共享根 `package-lock.json` 和质量命令。
- 客户端构建前必须先构建它依赖的共享包。
- 公开测试前必须用数据库、对象存储和异步任务替换进程内状态与本地文件。
- Taro 构建依赖只用于构建静态 H5/小程序产物，不属于服务端生产依赖。
