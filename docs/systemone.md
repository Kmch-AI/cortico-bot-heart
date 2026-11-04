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

## 服务侧前置

服务 0.4.3 只有 speech 路由；heart 需要：

- `POST /v1/systemone` 原样转发到 Jev 兼容服务，不偷偷改写为 OpenAI chat；
- `POST /v1/embeddings`、`POST /v1/rerank` 代理到本地 llamacpp；
- 没有条目时返回 503/501，heart 降级。

这些改动在服务插件中，不混进 heart 0.1。
