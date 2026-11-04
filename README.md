# @kmchai/cortico-bot-heart

`Kmch AI · 心`。Cortico 的 bot 层：心情、关系、注意力、持久记忆，以及按信息来源路由的文字/语音决策。

入口：`index.ts`。bot id `heart`，契约 `bot v7`。默认声明 `console`、`qq`、`voice`、`service`。

## 它做什么

- **选择性说话**：按心情、关系、话题相关度、是否被点名，决定回复、观察（Core 支持时零成本 drop，否则语义沉默）或稍后。
- **持久记忆**：SQLite 为真源；写入走保存决策；检索按 hot/warm/cold 与 scope 过滤；记忆是人格的载体。
- **异步记忆**：钩子只入队，后台 fork 提取，`injectDeferred` 回注短结果；不阻塞主回合。
- **语音决策**：只决定「发 / 不发」；发到控制台本机、QQ 还是其他 World，由事件来源和该 World 的 speak 工具决定。
- **SystemOne**：服务插件提供的 `/v1/systemone` typed questions（`noul` / `choice` / `score`）；不可用时降级到启发式。

## 安装与部署

在部署的 `deployment.json` 里把 `bot` 指到包名：

```json
{
  "bot": "@kmchai/cortico-bot-heart"
}
```

依赖：

- Node ≥ 22.23（`node:sqlite`）。
- 可选 `sqlite-vec@0.1.9`（`optionalDependencies`），没有时向量召回降级为 JS 余弦/LIKE。
- 完整决策质量需要服务插件提供 `/v1/systemone`、`/v1/embeddings`、`/v1/rerank`；没有时按降级路径运行。

配置组见 `config.ts`。密钥只存 `.env` 变量名（`decision.tokenSecret` / `vectors.tokenSecret`），配置里不存 token 值。

## 记忆目录

默认 `paths.memory` 下：

```
heart.db              SQLite 真源（WAL）
backups/              VACUUM INTO 备份
decisions/YYYY-MM-DD.jsonl  决策 trace
export/records.jsonl  可移植导出
blobs/                mem: 句柄
```

`*.db`、`backups/` 不进 git；`export/`、`decisions/` 可按部署策略保留。

## 迁移

旧 `@kmchai/cortico-bot-gateway` 硬切：

1. `deployment.json` 的 `bot` 改为 `@kmchai/cortico-bot-heart`。
2. 旧 `worlds.gateway.*` 配置不迁移；按 `config.ts` 重新配置。
3. 旧 gateway 没有真实 Memory；`memory/` 下的占位 `MEMORY.md` 不导入。
4. 两个包不能同时作为同一个 bot；部署二选一。

## 已知边界

- 检测 `CoreApi.deliveryDrop`：支持时沉默/暂缓返回 `{ action: 'drop' }`，不写 session、不调主模型；stock Core 上仍是语义沉默，会跑一次主模型。见 `docs/core-drop.md`。
- 服务插件 0.7.0 已提供 `/v1/systemone`、`/v1/embeddings`、`/v1/rerank`；StartLux 是 `llamacpp` 条目下的模型（`tasks: ['systemone']`），不再单独建 systemone 服务。部署时把 `decision.serviceUrl` / `vectors.serviceUrl` 指到服务网关。服务不可用时仍走降级。
- 输出 arbiter 已接线：默认 `auto`，只在 `needsArbiter` 或 `output.mode=arbiter` 时 fork 候选；候选只做文本，不执行工具。
- 显式「记住」即使被 SystemOne skip 也不向用户确认；这是已接受的信任代价。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm build:webui
```

在 Cortico checkout 根目录：

```sh
pnpm describe:extension <本包目录>
pnpm check:extension <本包目录>
```

文档索引：`docs/architecture.md`、`docs/memory.md`、`docs/storage.md`、`docs/async-memory.md`、`docs/routing.md`、`docs/systemone.md`、`docs/core-drop.md`、`docs/state-model.md`、`docs/prompts.md`、`docs/operations.md`、`docs/testing.md`、`docs/migrations.md`。

## License

MIT
