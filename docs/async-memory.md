# 异步记忆

## 原则

钩子只拷贝不可变数据并入队，不 await 提取、保存决策、embedding 或巩固。主回合优先，后台不抢占。

```
onDelivery / onBatchEnd / onTurnEnded / onHandoff
        ↓ enqueue（有界）
MemoryWorker 串行
        ↓ runDirectWorker(core.llm, tools: [memory_propose])
结构化 ops
        ↓ writeCandidate → MemoryStore.apply（SQLite 事务）
trace（不回注主会话）
```

## 钩子

- `onDelivery`：只把本批事件放入 `pendingEvents`；turn plan 和检索仍同步，因为本回合要用。
- `onBatchEnd`：合并助手输出与事件，入队；清空缓冲。立即返回。
- `onTurnEnded`：记录语音 miss 等观测；不等待后台。
- `onHandoff`：先 `flushPacket()` 把当前缓冲入队；不再从快照重复提取助手正文；同步注入一句短交接笔记；返回 `{ tail: null }`，不等待后台。
- `onIdle`：心情/注意力衰减；按间隔触发确定性巩固。

## 队列

- 串行；同一时刻最多一个后台工作循环。
- 有界（默认 16）；满时丢弃最低优先级包，保留 handoff 与显式 `memory_note`。
- 重复包按 event id / 内容 hash 吸收；不承诺 exactly-once。
- 进程重启会丢未完成包；启动后从最近事件补偿提取是后续项。

## 直连 core.llm

- 用 `memory/runtime.ts` 的 `runDirectWorker` 直接调用 `core.llm`，**不走 `spawnFork`**，因此
  SessionTracker 不会登记 `memory-N`，控制台与 fork 视图不会为每次记忆多出窗口；stock Core 即可。
- 模型参数取 `config.providers[activeProvider].spec`；缺失时跳过提取并写 trace。
- 工具表只有 `memory_propose`，不含 World 工具；后台不能发消息。
- 提交是“提议”：`MemoryStore` 再校验 schema、权限、去重与冲突。每个候选一个事务；同一包里前面的候选可能已提交，后面的失败只回滚当前事务，整包重试时由内容 hash 幂等吸收。
- 超时默认 120s，用 `AbortController` 取消在途请求；超时丢弃该包并写 trace。
- 代价：这些后台调用不出现在 session/用量表里；耗时与结果只写决策 trace。

## 回注

- **不回注**。Core 会把内部事件渲染成 user 消息；一条“记忆已整理”会唤醒主模型、污染历史，
  还可能让模型把它当用户发言多回一句。自主记忆必须真正静默，只写 trace 与 Memory 页。
- 用户明确说“记住”时，主模型在**当回合**正常回复；保存结果不在对话里确认。
- `injectInternal` 只用于钩子内的即时提示（例如 opening/handoff），不用于记忆回执。

## 失败

- 后台请求失败/超时：丢弃包，写 trace，不影响主 session。
- SQLite 失败：当前候选事务回滚；worker 把该包重排，最多重试 3 次（0.5s/1s/1.5s 退避）；仍失败写 trace 并丢弃。
- 重复包：同一批事件 + 同一段助手输出在 10 分钟内只提取一次。
- 显式候选被 skip：仍写 `memory_ops` 审计与 `explicitSkipped`；不回注。
