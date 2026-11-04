# 异步记忆

## 原则

钩子只拷贝不可变数据并入队，不 await 提取、保存决策、embedding 或巩固。主回合优先，后台不抢占。

```
onDelivery / onBatchEnd / onTurnEnded / onHandoff
        ↓ enqueue（有界）
MemoryWorker 串行
        ↓ spawnFork({ id: 'memory', tools: [memory_propose] })
结构化 ops
        ↓ writeCandidate → MemoryStore.apply（SQLite 事务）
injectDeferred('memory.result', () => 短句)
```

## 钩子

- `onDelivery`：只把本批事件放入 `pendingEvents`；turn plan 和检索仍同步，因为本回合要用。
- `onBatchEnd`：合并助手输出与事件，入队；清空缓冲。立即返回。
- `onTurnEnded`：记录语音 miss 等观测；不等待后台。
- `onHandoff`：把快照里的助手输出入队；同步注入一句短交接笔记；返回 `{ tail: null }`，不等待 fork。
- `onIdle`：心情/注意力衰减；按间隔触发确定性巩固。

## 队列

- 串行；同一时刻最多一个记忆 fork。
- 有界（默认 16）；满时丢弃最低优先级包，保留 handoff 与显式 `memory_note`。
- 重复包按 event id / 内容 hash 吸收；不承诺 exactly-once。
- 进程重启会丢未完成包；启动后从最近事件补偿提取是后续项。

## fork

- `ForkOptions.id = 'memory'`，使用 `declareSessions` 里的非持久 session。
- 工具表只有 `memory_propose`，不含 World 工具；fork 不能发消息。
- 提交是“提议”：`MemoryStore` 再校验 schema、权限、去重与冲突，事务失败整包回滚。
- 超时默认 120s；超时丢弃该包并写 trace；fork 的 Promise 仍可能完成，但结果不再应用。

## 回注

- 后台结果统一 `core.injectDeferred('memory.result', () => 短句)`；钩子内即时提示才 `injectInternal`。
- 只在有实质新增/更新/合并时回注；无变更不回注，避免无意义唤醒。
- 回注只发短句（“新增 1 条，更新 1 条”），不把 fork 全文塞回主上下文；细节用 `memory_read`。
- `injectInternal` / `injectDeferred` 在 loop 不 active 时是 no-op；记忆已落库，丢了通知不影响下次检索。

## 失败

- fork 失败/超时：丢弃包，写 trace，不影响主 session。
- SQLite 失败：整包回滚；worker 下次再试。
- 显式候选被 skip：仍写 `memory_ops` 审计与 `explicitSkipped`；不回注。
