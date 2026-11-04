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
    "depth": { "type": "score", "instructions": "...", "legend": { "0": "...", "4": "..." } }
  }
}
```

响应：

```jsonc
{
  "model": "jev-latest",
  "answers": {
    "action": { "type": "choice", "choice": "respond", "confidence": 0.82, "probabilities": {} },
    "addressed": { "type": "noul", "noul": 0.96 },
    "depth": { "type": "score", "score": "2", "confidence": 0.7, "legend": {}, "probabilities": {} }
  },
  "usage": { "input_tokens": 412, "output_tokens": 0 }
}
```

限制：

- `state` 最大 65,536 tokens；超限返回 `422 STATE_TRUNCATED`，heart 发送前也会拒绝静默截断。
- `questions` 1–256；`choice` 2–255 项；`score` 2–10 级。
- `confidence` 是按模型校准的 top probability，阈值不能跨模型复用。
- SystemOne 不生成文本；`selfIntent`、记忆正文、查询串、`voiceInstruct` 由主模型/fork 写。

## 任务

| 任务 | questions |
|---|---|
| `turn_plan` | `action` choice；`addressed` / `voice` / `needs_arbiter` noul；`intent` / `stance` / `length` / `directness` choice；`depth` / `playfulness` score |
| `appraise` | valence / arousal / energy / tension / importance / relationship_delta score |
| `memory_write` | `save` noul；`op` choice；`target` choice（top-8 邻居）；confidence / salience score |
| `memory_rerank` | 每个候选一个 noul（最多 40） |
| `output_arbiter` | 2–3 个候选 id 的 choice |

## 客户端

- 超时：turn plan 2s；memory write/rerank 3s；appraise 2s。
- 重试：只对连接失败/5xx 重试一次；4xx 不重试。
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
