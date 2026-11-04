# 架构

## 四层位置

```
QQ / 控制台 / 其他 World 事件
            ↓
Core（session、事件流、模型调用）
            ↓
Heart Persona ── Memory（SQLite 真源）
            │       ├─ identity / relationship / episodic / semantic
            │       ├─ mood / attention
            │       └─ decision trace / audit
            ↓ 只通过工具与事件
Voice / Service / QQ / Console / WebSearch World
```

Persona 拥有记忆的语义解释权；Memory 是被动数据。World 与 Persona 只通过事件、工具、环境提示词沟通。

## 模块

| 文件 | 职责 |
|---|---|
| `index.ts` | `BotDefinition`：id、默认配置、World 声明、`build()`、`describe` |
| `config.ts` | `HeartConfig`、默认值、WebUI 配置组 |
| `persona/persona.ts` | session、生命周期钩子、回合决策、状态头、worker 接线 |
| `persona/PREFIX.md` | 稳定人格前缀：身份、表达目标、工具路由 |
| `persona/BEHAVIOR.md` | 交际行为原则：意图、深度、沉默、自主 |
| `persona/MEMORY_PROTOCOL.md` | 记忆读写协议、隐私、工具 |
| `state/mood.ts` | 心情慢变量、衰减、评估 |
| `state/relationship.ts` | 按 person/group 的关系状态 |
| `state/attention.ts` | 话题、未完成线程、待接、社交能量 |
| `state/stateCard.ts` | 动态状态卡与预算裁剪 |
| `decision/systemone.ts` | `/v1/systemone` 客户端、校验、超时、熔断 |
| `decision/questions.ts` | `noul` / `choice` / `score` 问题与答案映射 |
| `decision/fallback.ts` | SystemOne → 启发式降级、trace |
| `decision/probe.ts` | 服务 `/health` 能力探测 |
| `memory/types.ts` | 记录、候选、操作、查询、Store 接口 |
| `memory/sqlite.ts` | SQLite 主存储、FTS、可选 sqlite-vec |
| `memory/store.ts` | 存储工厂与 JSONL 降级 |
| `memory/worker.ts` | 后台队列、fork 提取、结构化提交、回注 |
| `memory/write.ts` | 保存决策与事务写入 |
| `memory/retrieve.ts` | 查询构造、混合召回、MMR、预算 |
| `memory/consolidate.ts` | 合并、分层、容量控制 |
| `memory/tools.ts` | 主 session 的 memory 工具 |
| `memory/vectors.ts` | embeddings / rerank HTTP 与 hash 降级 |
| `output/turnPlan.ts` | TurnPlan、启发式、SystemOne 答案映射、提示词渲染 |
| `output/route.ts` | 按来源解析文字/语音 DeliveryPlan |
| `output/voice.ts` | 语音「发/不发」门 |
| `output/arbiter.ts` | 高 stakes 候选生成/选择 |
| `webui/` | Persona / Memory 页面板 |

## Session

- `main`：`persistent: true`、`receivesEvents: true`。工具 = 挂载 World 工具 + `memory_*` + `end_turn`。
- `memory`：后台 fork 用，非持久、不接收事件；工具表只含 `memory_propose`。
- `sessionHead()` 每次请求生成状态卡、turn plan、DeliveryPlan、记忆卡片；不写入持久历史。
- 静态人格与协议在 `systemSegments`，保持前缀稳定。

## 一次事件

1. Core 投递事件到 `main`。
2. `onDelivery`：
   - 过滤出站事件（排除 `*.self` 与 Persona/Core 内部通知）；
   - 更新 attention；
   - `ChannelRouter` 按来源生成 `DeliveryPlan`；
   - `DecisionPlane` 产出 `TurnPlan`（SystemOne 或启发式）；
   - 语音门只决定发/不发；
   - respond 时检索记忆卡片；silence/defer 时先入记忆包，Core 支持 drop 就丢弃整批，否则注入内部说明走语义沉默。
3. 主模型生成正文/工具调用；JSON 头提供约束，不写进可见正文。
4. `onBatchEnd` 把本批事件 + 助手输出入队；`onHandoff` 入队快照并注入短交接笔记；钩子不 await。
5. `MemoryWorker` 串行 fork 提取 → `writeCandidate` 保存决策 → SQLite 事务 → `injectDeferred` 短回执。
6. `onIdle` / 定时器触发心情衰减、注意力衰减、确定性巩固。

## 失败隔离

- SystemOne 失败：启发式继续；不因决策服务故障而不回复。
- 记忆失败：本轮不注入记忆；后台重试；绝不因记忆失败而停止对话。
- SQLite 忙：短 busy timeout；失败的包由 worker 有界重试（最多 3 次），仍失败写 trace，不影响主对话。
- 语音失败：退回来源渠道文字；不重复合成、不绕过 QQ 确认。
- 后台 fork 失败/超时：丢弃该包并写 trace；下一次再整理。

## 不做

- 不实现 TTS/播放/QQ/OneBot/Live2D/Web 搜索。
- 不 import 服务或 World 包。
- 不在 Persona 里直接执行 World 工具。
- 不把「每句话都像人」当目标；允许沉默、短句、不完整。
