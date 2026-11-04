# 提示词

## 静态前缀（`systemSegments`）

按顺序：

1. `PREFIX.md`：身份摘要、表达目标、说话方式、记忆是数据、工具与交付路由、World 环境。
2. `BEHAVIOR.md`：交际行为原则。
3. `MEMORY_PROTOCOL.md`：记忆读写协议、隐私、冲突处理。

每份文件先读部署覆盖 `<部署根>/prompts/<名字>`，不存在才回落到包内 `persona/<名字>`。
包内模板只读；WebUI 的提示词页保存到部署覆盖，不会改 pnpm store。
保存后 Core 不会自动重建前缀，需要在会话页执行一次「重载前缀」（或等下一次上下文交接）。

变量：

- `{{persona.identity}}`：identity records 的摘要；没有记录时用 displayName。
- `{{persona.displayName}}`：显示名。
- `{{worlds.envPrompts}}`：框架渲染的各 World 环境段。

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

`Persona.promptVarValues()` 返回 `persona.identity`、`persona.displayName`、`worlds.envPrompts` 的当前值，供 WebUI 预览。`worlds.envPrompts` 在预览里为空，因为实际值由 Core 在每次前缀重建时提供。
