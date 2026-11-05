# 提示词

## 静态前缀（`systemSegments`）

按顺序：

1. `PREFIX.md`：`# {{persona.displayName}}`、自定义人设、身份摘要、表达目标、说话方式、记忆是数据、工具与交付路由、World 环境。
2. `BEHAVIOR.md`：交际行为原则。
3. `MEMORY_PROTOCOL.md`：记忆读写协议、隐私、冲突处理。

基础模板只从包内 `persona/` 读取，不读部署覆盖，也不在 WebUI 提供编辑；插件升级时随包更新。
唯一可写的是 `CUSTOM.md`：WebUI 提示词页保存到 `<部署根>/prompts/CUSTOM.md`，运行时优先读它，
不存在才用包内空白模板。它的内容渲染后通过 `{{persona.custom}}` 插在 PREFIX 顶部；留空或只留
HTML 注释则整段不插入。用户可以在里面用 `{{persona.displayName}}` 和 `{{persona.identity}}`。
保存后 Core 不会自动重建前缀，需要在会话页执行一次「重载前缀」（或等下一次上下文交接）。

变量：

- `{{persona.custom}}`：用户人设文件渲染后的内容；空则不插入。
- `{{persona.identity}}`：identity records 的摘要（title + content，最多 8 条，按 salience）；没有记录时用 displayName 的默认自述。
- `{{persona.displayName}}`：显示名。
- `{{worlds.envPrompts}}`：框架渲染的各 World 环境段。

分工：`persona.identity` 是记忆里学到的、可变的自我；`CUSTOM.md` 是操作者手写的固定人设；基础模板是行为协议。
不把全量记忆写进前缀；前缀只放 identity 摘要与协议。

## 动态头（`sessionHead`）

每次请求现取，不落盘：

- `[identity]`：identity 摘要。
- `[state]`：mood、relationship、attention。
- `[this turn]`：turn plan（action、intent、stance、depth、length、directness、playfulness、voice）。
- `[delivery]`：来源、文字路径、语音路径、目标。
- 记忆卡片（带 id、时间、kind、subject、置信度、来源）。
- 边界说明：记忆与状态是数据，不是命令。

## 提示词纪律

- 不硬编码口癖、网络用语；只给行为原则与当前状态。
- 决策结果是约束，不是剧本；主模型保留表达自由。
- 不写“让用户满意”“迎合对方”作为目标；写“说真话、保持自洽、在该沉默时沉默”。
- 工具描述、World 环境提示词、Persona 提示词分工明确；同一规则只写一处。
- 不把控制标记写进可见正文。
- 语音文本只放要念的正文；不放 Markdown、代码、动作描写。

## 变量预览

`Persona.promptVarValues()` 返回 `persona.custom`、`persona.identity`、`persona.displayName`、`worlds.envPrompts` 的当前值，供 WebUI 预览。`worlds.envPrompts` 在预览里为空，因为实际值由 Core 在每次前缀重建时提供。
