# 测试

## 命令

```sh
pnpm typecheck        # Node 侧 + 浏览器侧
pnpm test             # vitest
pnpm build:webui      # dist/webui.js + webui.css
```

在 Cortico checkout 根目录：

```sh
pnpm describe:extension <本包目录>
pnpm check:extension <本包目录>
```

## 现有覆盖

- `tests/unit/sqlite.test.ts`：创建/读取/检索/精确去重/合并/版本/隐私 scope/状态键。
- `tests/unit/state.test.ts`：心情评估与衰减、关系派生状态、注意力线程。
- `tests/unit/decision.test.ts`：SystemOne typed answers 映射、网络失败降级、超限 state 拒绝。
- `tests/unit/route.test.ts`：控制台/QQ/未知 World/多来源路由与目标。
- `tests/unit/retrieve.test.ts`：查询构造、相关召回、abstain、写入去重、显式候选审计。
- `tests/integration/persona.test.ts`：私聊回复路由、群聊语义沉默、内部通知不触发决策、静态前缀、后台直连记忆。
- `tests/integration/http-services.test.ts`：真实本地 HTTP 下的 SystemOne / embeddings / rerank 形状。
- `tests/unit/jsonl.test.ts`、`tests/unit/vector.test.ts`：JSONL 降级持久化与可选 sqlite-vec KNN。

## 待补

- 真实 SQLite 文件 + `sqlite-vec` 的 KNN/过滤回归（当前单元测试用 `:memory:`，向量路径单独手工验证）。
- 后台 worker 的直连 `core.llm` 路径/超时/队列上限（已有基础异步测试）。
- arbiter 候选生成/选择（当前只在集成路径中留接口，未做专门 golden）。
- SystemOne 服务契约的 HTTP fake（当前 fake fetch）。
- Golden 对话集：silence/voice/memory 选择，允许措辞变化，断言结构与关键事实。
- 故障注入：SQLite 忙/半写、embedding 500、rerank 501、后台请求超时。
- 安全：跨 scope 泄漏、secret 不落盘、群聊私事不在群聊/第三方检索。

## 验收目标（初版）

- 记忆写入 precision ≥ 0.8（人工抽样）；重复率 < 5%。
- 检索注入 token p95 ≤ 1200；无关记忆注入率 < 10%。
- 新旧事实冲突不同时作为当前事实注入。
- 群聊闲聊 silence 合理率 ≥ 80%（人工）。
- 语音不重复发送；QQ 文字/语音都走 QQ 工具；控制台语音不误发 QQ；无语音出口文字仍走来源渠道。
- 后台记忆任务不阻塞主回合；`onHandoff` 不等待后台；结果只落 Memory 与 trace，不新建 session。
- 显式“记住”即使被 skip 也留 explicit 候选与 trace。
