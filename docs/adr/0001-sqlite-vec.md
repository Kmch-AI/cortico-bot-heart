# ADR 0001: SQLite + 可选 sqlite-vec

- 状态：接受（2026-11-03）
- 背景：记忆需要过滤、排序、去重、事务、增量更新和 KNN；JSON+MD 全量扫描/重写不可持续。
- 决定：`node:sqlite` 为运行真源；`sqlite-vec@0.1.9` 做向量索引；JSONL 只做降级、审计、导出。
- 理由：内置 SQLite 无原生编译；事务与 FTS 同库；5k KNN 约 4ms，50k×768 约 85ms。
- 代价：同步 API 会阻塞事件循环；sqlite-vec 是预编译扩展，平台覆盖有限。
- 缓解：主线程短事务/小 KNN；批量走 worker；无扩展时 JS 余弦；`optionalDependencies`。
- 替代：better-sqlite3（需编译）、sql.js（持久化/扩展弱）、专用向量库（额外运维）。
