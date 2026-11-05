# SystemOne

## 契约

`POST /v1/systemone`，TypeSafe Jev wire format：

```jsonc
{
  "model": "jev-latest",
  "state": { "events": "...", "mood": {}, "relationship": {}, "hot": [] },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "...",
      "criteria": { "respond": "...", "silence": "...", "defer": "..." }
    },
    "addressed": { "type": "noul", "instructions": "..." },
    "depth": {
      "type": "score",
      "instructions": "...",
      "criteria": ["自动反应", "浅层", "一般", "深度", "严谨推理"]
    }
  }
}
```

`score` 的等级描述必须是**最低级在前的数组**，字段名是 `criteria`；写成 `legend: {...}` 会被 StartLux / Jev 以
`422 a score question needs criteria: a list of levels, lowest first` 拒绝。`choice` 的 `criteria` 才是
`{选项: 描述}` 映射；`noul` 可选 `criteria: {true, false}`。

响应：

```jsonc
{
  "model": "jev-latest",
  "answers": {
    "action": { "type": "choice", "choice": "respond", "confidence": 0.82, "probabilities": {} },
    "addressed": { "type": "noul", "noul": 0.96 },
    "depth": { "type": "score", "score": 2.0, "confidence": 0.7, "legend": { "0": "...", "4": "..." }, "probabilities": {} }
  },
  "usage": { "input_tokens": 412, "output_tokens": 0 }
}
```

`score` 答案是**按等级概率加权的期望值**（0..n-1），不是等级 id 字符串；`legend` 只是等级 id 到描述的映射。
heart 直接使用数值并四舍五入到最近等级。

限制（与 StartLux / Transformers 的 `/v1/systemone` 校验一致）：

- heart 在发送前按 65,536 tokens 估算拒绝超长 `state`，避免静默截断；这是 heart 自己的保护，不是上游错误码
  （StartLux 不校验该字段，实际上限取决于引擎上下文）。
- `questions` 1–64；`choice` 1–26 项（heart 至少要求 2）；`score` 2–10 级。
- `confidence` 是按模型校准的 top probability，阈值不能跨模型复用。
- SystemOne 不生成文本；`selfIntent`、记忆正文、查询串、`voiceInstruct` 由主模型或后台直连调用写。

## 任务

| 任务 | questions |
|---|---|
| `turn_plan` | `action` choice；`addressed` / `voice` / `needs_arbiter` noul；`intent` / `stance` / `length` / `directness` choice；`depth` / `playfulness` score |
| `appraise` | valence / arousal / energy / tension / importance / relationship_delta score |
| `memory_write` | `save` noul；`op` choice；`target` choice（top-8 邻居）；confidence / salience score |
| `memory_rerank` | 每个候选一个 noul（最多 40） |
| `output_arbiter` | 2–3 个候选 id 的 choice |

## 客户端

- 热路径预算：`decision.interactiveTimeoutMs`（默认 1.2s）只用于 `turn_plan` 与 `appraise`，且只尝试一次；超时立即启发式，不重试。
- `appraise` 不再和 `turn_plan` 一起阻塞回合：它在 `turn_plan` 之后后台运行，只影响心情/关系，不影响这一句的回复。
- 后台超时：`decision.timeoutMs`（默认 2s）用于 memory write/rerank/arbiter；连接失败/5xx 在这些后台路径重试一次，4xx 不重试。
- 熔断：连续 3 次失败后 60s 直接降级。
- 缓存：同一事件批的 turn plan 只算一次；同一查询的 rerank 批内复用（0.1 只做单次）。
- trace：`memory/decisions/YYYY-MM-DD.jsonl`，含 task、模式、延迟、错误、摘要；不写密钥与完整隐私正文。

## 降级

| 失败 | 行为 |
|---|---|
| SystemOne 不可用 | 启发式：私聊/点名/提问 → respond，否则 silence；voice=false |
| 主模型也不可用 | 同上；不阻塞事件结算 |
| embeddings 不可用 | `hashEmbedding` 粗召回，标记 degraded |
| rerank 不可用 | 0.45 向量 + 0.25 BM25 + 0.15 新近 + 0.15 重要度的加权近似（当前实现为 RRF + confidence/salience/recency 加权） |

## 服务侧

服务 0.7.0 已提供：

- 条目按模型任务路由：`systemone` / `embeddings` / `rerank` 同级；
- `POST /v1/systemone` 转发到 `tasks` 含 `systemone` 的条目：外部 Jev 端点直接用，llama.cpp 的 StartLux 走同一条目的伴生 `startlux-decide`；
- `POST /v1/embeddings`、`POST /v1/rerank` 转发到 `tasks` 含对应任务的条目；
- 没有对应任务返回 503；llamacpp 上游不支持 rerank 时返回 501；heart 降级；
- heart 探测 `/health` 的 `services[].tasks`，因此 StartLux 作为 llamacpp 模型仍会被识别为 systemone。

部署时把 `decision.serviceUrl` / `vectors.serviceUrl` 指到服务网关（默认 `http://127.0.0.1:9883`），并让 `decision.tokenSecret` / `vectors.tokenSecret` 与服务网关的令牌变量一致。
