# Changelog

## 0.1.1

- 扩展介绍统一为中文的「定位 + 能力 + 边界」格式；npm `description`、市场中文介绍与 README 首段同步；英文市场介绍同步为同一格式的英文镜像。
- 标签按功能调整：去掉 `internal-state`（这是给 World 的 notice；心是 bot 扩展，内部状态本来就在 Memory），加 `companion`（心情、关系、注意力与是否开口）。
- 其余标签保留：`im`、`qq`、`voice`、`memory`、`high-cost`、`sensitive-data`、`external-setup`、`experimental`。

## 0.1.0

首个版本。

- 新包 `@kmchai/cortico-bot-heart`，bot id `heart`，显示名 `Kmch AI · 心`。
- 心情、关系、注意力状态；按状态与话题决定回复 / 沉默 / 稍后。
- SystemOne typed decision（`noul` / `choice` / `score`）；失败降级到启发式。
- SQLite（`node:sqlite`）记忆真源，可选 `sqlite-vec`；JSONL 只做降级、审计与导出。
- 异步记忆：钩子只入队，后台 fork 提取，`injectDeferred` 回注短结果。
- 记忆工具：`memory_search` / `memory_read` / `memory_note` / `memory_pin` / `memory_forget`。
- 按事件来源路由文字与语音：控制台直接文字 + 本机语音；QQ 走 QQ 工具；其他 World 用其自己的 speak 工具。
- Persona / Memory 页：状态、记忆列表、决策 trace。
- 检测 `CoreApi.deliveryDrop`：支持时 silence/defer 返回 `{ action: 'drop' }`，先把事件交给记忆 worker；stock Core 上继续用语义沉默。`silence.mode` 可选 `auto` / `semantic` / `core-drop`。
- 服务探测读取 `/health` 的 `services[].tasks`：StartLux 作为 `llamacpp` 条目的 `systemone` 模型也能被识别；旧服务回退到类型/模型名。
