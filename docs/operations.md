# 运维

## 配置

配置组（`config.ts`）：

- `heart-decision`：启用 SystemOne、服务地址、token secret 名、模型、超时、置信度阈值、沉默模式。
- `heart-memory`：后端、hot/warm 预算、topK、检索预算、向量维度、后台巩固。
- `heart-output`：输出模式、语音开关/群聊默认/频率、mood 惯性/半衰期、巩固间隔。

完整字段见 `HeartConfig`。密钥只存 `.env` 变量名，不存值。

## 数据目录

```
memory/
  heart.db
  heart.db-wal
  heart.db-shm
  backups/
  decisions/YYYY-MM-DD.jsonl
  export/records.jsonl
  blobs/
```

- `heart.db*` 不进 git。
- `backups/` 不进 git；迁移前必须 `VACUUM INTO` 备份。
- `export/` 可移植；`decisions/` 可按保留策略轮转。

## WebUI

Persona 页（`persona:heart`）：

- `heart` 面板：当前 mood、turn plan、DeliveryPlan、记忆统计、后台队列、决策 trace。

Memory 页：

- `memories`：记忆列表/搜索/读取/导出/巩固/删除（删除是危险操作，需确认）；`identity_pending` / `identity_approve` / `identity_reject` 处理核心身份待审。
- `decisions`：最近决策 trace。

面板只读/操作 Memory，不替代 World 页面。

## 备份与恢复

```ts
store.backup('memory/backups/heart-2026-11-04.sqlite');
```

恢复：

1. 停止 bot。
2. 用备份替换 `heart.db`（同时删除 `-wal`/`-shm`）。
3. 启动；检查 `memory_meta(schema_version)` 与 `dim`。
4. 如果 `dim` 与当前配置不一致，重建向量索引或回退到配置中的 dim。

## 故障排查

| 现象 | 检查 |
|---|---|
| 记忆写入但不检索 | `stats.vectorEnabled` / `ftsEnabled`；`memory_meta(dim)`；查询是否 <3 字走 LIKE |
| SystemOne 一直降级 | `/health` 是否有 `systemone`；token secret 名；超时；熔断 60s |
| embedding 失败 | 服务 `/v1/embeddings` 是否 200；维度是否等于 `vectors.dim` |
| SQLite 忙 | 是否有长事务/多进程；`busy_timeout` 250ms；后台巩固是否同步跑太久 |
| 语音没发 | plan.voice、语音门、来源是否有语音出口；QQ 是否走了 `qq_draft`/`qq_confirm` |
| 群聊刷屏 | `voice.groupDefault` 应为 false；检查 `voice.maxPerTurns` |
| 显式“记住”没反应 | SystemOne 可能 skip；查 Memory 页审计/`memory_ops`；这是已接受取舍 |

## 隐私清除

- `memory_forget` 默认只记录请求；操作者在 Memory 页确认后 soft delete，必要时 hard delete。
- 删除留 `memory_ops` 审计；identity 变更只版本化，不物理删除。
- 备份中仍可能有旧记录；按部署保留策略轮转/删除备份。
