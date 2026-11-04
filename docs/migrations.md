# 迁移

## 0.1 初始 schema

- `schema_migrations(version=1)`，`PRAGMA user_version=1`。
- `records` / `record_versions` / `record_evidence` / `record_links` / `record_vectors` / `records_fts` / `vec_records` / `memory_meta` / `memory_ops` / 状态表。
- 向量维度写入 `memory_meta(dim)`；变化必须重建 `vec_records`。

## 从旧 gateway 迁移

旧 `@kmchai/cortico-bot-gateway` 没有真实 Memory，只有占位 `MEMORY.md`：

1. `deployment.json` 的 `bot` 改为 `@kmchai/cortico-bot-heart`。
2. 不迁移 `worlds.gateway.*`；按 `config.ts` 重新配置。
3. 不导入 `memory/MEMORY.md` 占位内容。
4. 旧包 deprecated；两个包不能同时作为同一个 bot。

## 迁移步骤（未来 schema）

1. 关闭 bot。
2. `VACUUM INTO memory/backups/pre-migration-<date>.sqlite`。
3. 运行迁移；失败不覆盖旧库。
4. 校验 `user_version`、`records` 计数、`vec_records` 维度。
5. 重建向量（如维度变化）：
   - 删除/重建 `vec_records`；
   - 重新 embedding hot/warm；
   - 期间检索降级为词法。
6. 启动后检查 `memory_meta(embedding_model)` / `dim` 与配置一致。

## 导出/重建

- `export/records.jsonl` 可移植；重建时导入为 records，再补 evidence/links。
- `decisions/`、`audit/` 只读，不参与重建真源。
- 不允许手工改 Markdown 后不回写数据库；需要走 UI 导入成新版本。
