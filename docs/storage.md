# 存储

## 主方案

- `node:sqlite` 的 `DatabaseSync`，同步 API。
- `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=250; foreign_keys=ON`。
- 应用层单写者队列；主线程只做点查、小 KNN、短事务。
- 批量/迁移/重建索引应放 `worker_threads`；0.1 的巩固是同步小批量，后续拆出。

打开扩展必须：

```ts
new DatabaseSync(path, { allowExtension: true });
db.enableLoadExtension(true);
db.loadExtension(getLoadablePath());
```

否则 Node 22 会报 `ERR_INVALID_STATE`。

## 表

| 表 | 说明 |
|---|---|
| `records` | 当前记录视图；`vec_rowid` 指向当前向量 |
| `record_versions` | 每次变更的快照、op、trace |
| `record_evidence` | event id / quote / 时间 / 来源 |
| `record_links` | entity / topic / causal / supports / contradicts / depends |
| `record_vectors` | record_id → vec_rowid / model / dim |
| `records_fts` | FTS5，`tokenize='trigram'` |
| `vec_records` | `vec0`，metadata `scope/status/tier`，cosine |
| `relationships` / `mood_state` / `attention_state` | 预留表；0.1 的小型状态经 `memory_meta` JSON 存，后续可迁到这些表做 SQL 视图 |
| `memory_meta` | schema/embedding/dim 与状态键 |
| `schema_migrations` | schema 版本 |
| `memory_ops` | 每个 op 的审计 |

## 向量

- `sqlite-vec@0.1.9` 是 `optionalDependencies`；没有时不安装失败，运行时探测。
- 向量写入前 L2 归一化；`vec0` 使用 `distance_metric=cosine`。
- KNN 必须先子查询取 top-k，再与 `records` 做普通 join/过滤：
  ```sql
  SELECT rowid, distance FROM vec_records WHERE embedding MATCH ? AND k = ?
  ```
  不要把 `MATCH` 直接写成与 `records` 的相关 join，否则可能全表扫描或卡住。
- `vec_records` 只索引 hot/warm；cold 不建向量，升层时再 embedding；降层/删除同步删向量。
- 维度写入 `memory_meta(dim)`；变化时重建 `vec_records` 并重新 embedding，期间向量召回降级为词法。
- 没有 sqlite-vec：向量 BLOB/JS 余弦或 JSONL 内存向量；FTS/元数据仍可用。

## FTS

- trigram 兼顾中文子串，但对少于 3 字符的查询不可靠。
- 短查询回退 `LIKE`/JS 子串；FTS 查询参数化并转义，不把用户文本拼进 `MATCH`。
- `records_fts` 与 `records` 在同一事务更新；失败不影响主记录。

## 备份与导出

- `VACUUM INTO '<path>'` 做一致性备份；迁移前必须备份。
- `export/records.jsonl` 可移植导出，可重建；不是运行真源。
- 操作审计在 SQLite 的 `memory_ops` 表；`decisions/` 按天 JSONL，不写密钥与完整敏感正文。需要时可从 `memory_ops` 导出 JSONL。
- Markdown 视图由 records 生成；手工编辑通过 UI 导入成新版本，不允许“文件改了但库没变”。

## 降级

| 情况 | 行为 |
|---|---|
| 没有 `node:sqlite` | `JsonlMemoryStore`，内存索引 + JSONL；启动告警 |
| 有 SQLite、没有 sqlite-vec | 向量存内存/JS 余弦；FTS/元数据走 SQLite |
| 平台不支持 sqlite-vec | 包照常安装；运行时 `vectorEnabled=false` |
| 库忙 | `busy_timeout=250ms`；失败由 worker 有界重试（最多 3 次） |
| 库损坏 | 从备份恢复；无备份时用 export/audit 重建；恢复期间只用 hot memory |
