# Changelog

## 0.1.10

- 撤销 0.1.9 的独立对话预算：删除 `decision.interactiveTimeoutMs`，`turn_plan`、`appraise` 与后台决策共用 `decision.timeoutMs`（默认 6s）；超时不再重试，避免一次超时变成两倍等待。
- `turn_plan` 与 `appraise` 同时发起，不再一前一后；回复只等 `turn_plan`，`appraise` 完成后更新心情/关系。
- `turn_plan` 从 10 问缩到 5 问：`action` / `intent` / `stance` / `length` / `voice`；没有语音出口或用户明确要求语音时省略 `voice`。`addressed` 来自输入标志，`directness` / `depth` / `playfulness` / `needsArbiter` 由 mood、意图和输入推导。
- `appraise` 从 6 问缩到 5 问：`valence` / `arousal` / `energy` / `tension` / `relationship_delta`；`importance` 由关系变化幅度推导。
- `turn_plan` state 改为压缩结构，约 500 tokens 估算预算；超限先删旧 `recent`、`hot`，最后截 `events`。
- 恢复 `console_send`：它只用于其他来源向控制台广播；控制台来源仍要求正文直出。显式语音请求在语音门中优先于模型的 `voice` 判断。

## 0.1.9

- 对话热路径不再等待 SystemOne 的后台超时：新增 `decision.interactiveTimeoutMs`（默认 1.2s），`turn_plan` 只尝试一次，超时立即启发式。
- `appraise` 改为在 `turn_plan` 之后后台运行，不再和 `turn_plan` 一起阻塞回复，也避免两个请求并发挤占单槽 llama 服务。
- SystemOne 客户端支持 `attempts`；超时/5xx 重试只保留在后台路径，热路径不再重试。
- 控制台不再向模型暴露 `console_send`，并在路由提示中要求直接输出正文；修复控制台只出现工具调用、没有正常消息的问题。

## 0.1.8

- 用户人设合回一整块 `PERSONA.md`，带类似旧 PREFIX 的默认模板（基本设定、性格底色、关系、表达目标、说话方式）。
- `PERSONA.md` 接在 `## 我是谁` + identity 摘要之后；identity 始终存在，用户不写也不会丢。
- 用户模板仍是纯 Markdown，不声明也不替换 `persona.displayName` / `persona.identity`；只有标题没有正文的空段在合并时去掉。
- 基础模板仍只读；提示词页只暴露 `PERSONA.md` 一个可编辑文档。

## 0.1.7

- `PROFILE` 槽现在始终先包含 identity 记忆摘要，再追加用户 `PROFILE.md` 的正文；用户不写也保留 identity。
- `persona.profile` 合并值同步为 identity + 用户正文；提示词页与文档同步。
- 其他槽（`PERSONALITY` / `RELATIONSHIP` / `GOALS` / `SPEECH`）行为不变。

## 0.1.6

- 用户人设槽（`PROFILE` / `PERSONALITY` / `RELATIONSHIP` / `GOALS` / `SPEECH`）不再声明 `persona.displayName` / `persona.identity`；提示词页不再显示这两个变量。
- 用户槽不再做变量替换，按纯 Markdown 原样进入 PREFIX；槽内写 `{{...}}` 会保留字面值。
- 回退逻辑不变：`PROFILE` 空用 identity 摘要，`GOALS` / `SPEECH` 空用包内默认，`PERSONALITY` / `RELATIONSHIP` 空省略整段。

## 0.1.5

- 修复提示词页仍能编辑 PREFIX / BEHAVIOR / MEMORY_PROTOCOL：基础模板不再出现在 `promptDocs` 中，只作为只读段显示。
- 人设拆成五个可分别填写的槽：`PROFILE`（我是谁/基本设定）、`PERSONALITY`（性格底色）、`RELATIONSHIP`（与对方的关系）、`GOALS`（表达目标）、`SPEECH`（说话方式）。每个槽只写正文，PREFIX 合并时补标题。
- `PROFILE` 为空时回退到 identity 记忆摘要；`GOALS` / `SPEECH` 为空时回退到包内默认；`PERSONALITY` / `RELATIONSHIP` 为空时整段省略。
- PREFIX.md 只保留标题、槽位标记、记忆、工具与 World 环境；`{{persona.identity}}` 仍是 identity records 摘要，不是用户人设。
- 版本 0.1.5。

## 0.1.4

- 基础提示词模板改为包内只读：PREFIX / BEHAVIOR / MEMORY_PROTOCOL 不再读部署覆盖，WebUI 也不提供编辑；已有部署覆盖会被忽略。
- PREFIX 开头改为 `# {{persona.displayName}}`，不再硬编码显示名。
- 新增用户可编辑的 `CUSTOM.md`（自定义人设）：保存到 `<部署根>/prompts/CUSTOM.md`，通过 `{{persona.custom}}` 插在 PREFIX 顶部；可用 `{{persona.displayName}}` 与 `{{persona.identity}}`，留空或只留注释则不插入。
- 提示词页只把 `CUSTOM.md` 标为可写；`persona.identity` 仍是记忆里 identity 记录的摘要，不是用户人设。

## 0.1.3

- 移除 Core drop 适配：Core PR [#371](https://github.com/Pal-AI-Lab/Cortico/pull/371) 被维护者拒绝，silence/defer 只走语义沉默（注入“不要回应”，主模型自行 `end_turn`）。
- 删除 `persona/coreCompat.ts`、`silence.mode` 配置与相关测试；移除 `docs/core-drop.md`；ADR 0004 记录拒绝理由与 `deliveryGate` 替代建议。

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
