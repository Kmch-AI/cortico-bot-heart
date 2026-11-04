# ADR 0002: 异步记忆

- 状态：接受（2026-11-03）
- 背景：提取、保存决策、embedding、巩固都可能慢；在钩子里 await 会拖住主回合。
- 决定：钩子只入队不可变 packet；`MemoryWorker` 串行 fork；结构化提交；`injectDeferred` 回注短句。
- 理由：`onHandoff` 被 Core await，不能等 fork；`sessionInfo().running` 是 fork 数，不是主循环活跃。
- 代价：进程重启丢未完成包；回注可能唤醒主 session；不承诺 exactly-once。
- 缓解：队列有界、内容 hash 幂等、handoff/显式 note 优先、无实质变更不回注。
