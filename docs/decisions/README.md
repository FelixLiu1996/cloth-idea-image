# 架构决策记录

架构决策记录（ADR）用于保存重要决定及其原因，避免新窗口只看到代码结果，却不知道当时的约束和权衡。

## 状态

- `Proposed`：提议中。
- `Accepted`：已采用。
- `Superseded`：已被新的 ADR 替代。
- `Deprecated`：不再建议，但可能仍存在于代码中。

ADR 的状态表示决策状态，不是功能完成状态。`Accepted` 只代表采用该方向；实际是否已经实现必须查看 [当前状态](../current-status.md)。

## 编写规则

- 文件名使用四位编号和简短名称，例如 `0004-use-object-storage.md`。
- 一个 ADR 只处理一个核心决定。
- 不直接修改已接受 ADR 的结论；如需改变，创建新 ADR 并标记替代关系。
- 至少包括背景、决定、原因、影响和状态。

## 当前决策

- [0001：采用 Taro 跨端客户端](0001-use-taro-cross-platform.md)
- [0002：服务端统一模型 Provider](0002-server-side-model-provider.md)
- [0003：H5 优先并使用匿名首版](0003-h5-first-anonymous-mvp.md)
- [0004：使用 npm workspaces 与 Fastify 组织首版应用](0004-use-npm-workspaces-fastify.md)
- [0005：采用证据门控的服装分析与确定性提示词编译](0005-use-evidence-gated-garment-analysis.md)
- [0006：使用可轮询的异步生图任务](0006-use-pollable-generation-jobs.md)
- [0007：先交付单进程受控试用版](0007-use-single-process-controlled-trial.md)
