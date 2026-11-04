# Changelog

## 0.1.2

- 修复 SystemOne `score` 请求格式：改用最低级在前的 `criteria` 数组，不再发 `legend`；修复上游 422 导致 turn plan / appraisal / memory_write 全部降级。
- 修复 `score` 答案解析：按数值期望等级（0..n-1）取整，不再拿 `legend` 键反查。
- 修复记忆写不进：用户姓名等“关于某人的事实”不再被当成核心身份卡进待审队列；只有 bot 自己的全局自述进入 `identity:pending`。
- 显式「记住」覆盖 SystemOne 的 skip/defer（精确重复仍去重），并保证当回合回复；自主记忆保持静默。
- 移除 `memory.result` 回注：它会被 Core 渲染成 user 消息、唤醒主模型并污染历史；写入结果只留 trace 与 Memory 页。
- 记忆提取与 arbiter 改为直连 `core.llm` 的后台工作循环（`memory/runtime.ts`），不创建 fork/session；stock Core 上控制台也不再为每次记忆多开窗口，无需改 Core。代价是后台调用不进 session/用量表，只写决策 trace。
- PREFIX / BEHAVIOR / MEMORY_PROTOCOL 支持部署覆盖：WebUI 保存到 `<部署根>/prompts/`，运行时优先读覆盖；包内模板保持只读。
- Memory 页新增「待审核心身份」，可批准或拒绝；修复 `identity:pending` 无入口的问题。
- Persona / Memory 页界面重做：状态概览、记忆搜索与类型/层级筛选、详情抽屉、决策历史表、服务探测；配置页按身份、决策、记忆、检索、输出分组。
- 修复巩固定时器重复累积：接管时清理旧的 `consolidate` 定时器，并只保留一个待触发条目。
- 修正 `docs/systemone.md` 的 wire format、`docs/async-memory.md` 的回注说明与 `docs/memory.md` 的身份边界。

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
