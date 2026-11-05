# 提示词

## 静态前缀（`systemSegments`）

按顺序：

1. `PREFIX`：`# {{persona.displayName}}` + `## 我是谁` + identity 摘要。
2. `CUSTOM`：整块用户人设 `PERSONA.md`。
3. `PREFIX_BODY`：`PREFIX.md` 的固定部分（记忆、工具与交付、World 环境）。
4. `BEHAVIOR.md`：交际行为原则。
5. `MEMORY_PROTOCOL.md`：记忆读写协议、隐私、冲突处理。

基础模板（`PREFIX.md`、`BEHAVIOR.md`、`MEMORY_PROTOCOL.md`）只从包内 `persona/` 读取，
不读部署覆盖，WebUI 也不提供编辑；插件升级时随包更新。

唯一可写的是整块 `PERSONA.md`：WebUI 提示词页保存到 `<部署根>/prompts/PERSONA.md`，运行时优先读它，
不存在才用包内默认模板。它接在 `## 我是谁` 和 identity 摘要之后，是纯 Markdown，不做变量替换，
也不声明 `persona.displayName` / `persona.identity` 之类的占位符。留空或只有 HTML 注释时整块不加，
identity 仍然保留。只有标题、没有正文的段会在合并时去掉。
保存后 Core 不会自动重建前缀，需要在会话页执行一次「重载前缀」（或等下一次上下文交接）。

合并变量（运行时内部使用，不是用户模板可写的占位符）：

- `persona.custom`：`PERSONA.md` 的正文；空则不插入。
- `persona.identity`：identity records 的摘要（title + content，最多 8 条，按 salience）；没有记录时用 displayName 的默认自述。
- `persona.displayName`：显示名。
- `worlds.envPrompts`：框架渲染的各 World 环境段。

分工：`persona.identity` 是记忆里学到的、可变的自我，始终在前；`PERSONA.md` 是操作者手写的整块人设；基础模板是行为协议。
不把全量记忆写进前缀；前缀只放身份、用户人设与协议。

`PERSONA.md` 默认模板（与旧 PREFIX 的结构类似）：

```md
### 基本设定与日常

### 性格底色

### 我与对方的关系

## 表达目标

## 说话方式
```

角色卡可以直接按这个结构填：`## 我是谁` 不用写（identity 会自动放在前面），把 `### 基本设定与日常`、`### 性格底色`、`### 我与小路泥的关系`、`## 表达目标`、`## 说话方式` 的正文放进同一个文件即可。

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
