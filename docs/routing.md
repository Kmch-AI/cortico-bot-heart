# 来源路由

决策层只回答「这一句要不要发语音」。发到哪里由 `ChannelRouter` 按事件来源决定。

| 来源 | 文字 | 语音 | 目标 |
|---|---|---|---|
| `console` | 直接输出；控制台时间线显示 | `voice_speak` 本机播放 | 当前控制台 |
| `qq` | `qq_draft` → `qq_confirm` | `voice_speak({silent:true})` → `[blob log:…]` → `qq_draft({voice})` → `qq_confirm` | `meta.conv`（`group:<id>` / `private:<id>`） |
| 其他 World | 该 World 的 `speak` 工具 | 该 World 的语音/播放工具 | 该 World 自己解释 |
| internal / 定时器 | 默认不输出 | 默认不发 | 主动发起时才选最近活跃渠道 |
| 多来源 | 最新外部来源 | 同左 | 被另一来源点名时用点名来源 |

## 规则

- QQ 文字和语音都走 QQ 工具；普通正文不等于已发送。
- 语音条不带文字、图片或引用；文字与语音是两条独立消息。
- 控制台 `console_send` 只用于主动广播到控制台对话页；普通回复不用它，避免重复。
- 其他 World 只使用自己的 speak 工具；没有语音出口就 `voice=false`，文字仍走该 World 的文本工具；没有文本工具就不发，记录 `text_unsupported`。
- 来源缺失/不认识：不主动发；需要时按配置默认渠道，并在 trace 写原因。
- 语音失败：退回来源渠道文字；不重复合成、不绕过 QQ 确认门、不直接连 OneBot。

## 语音门

`output/voice.ts` 在决策之后再做一层保守门：

- 配置关闭 → false。
- 没有语音出口 → false（`voice_unsupported`）。
- 速率限制：每 N 轮最多一次。
- 明确要求语音 → true。
- 私聊：情绪强度 ≥ 0.25 → true。
- 群聊：默认 false；`voice.groupDefault=true` 或情绪强度 ≥ 0.65 才 true。
- 其他来源：情绪强度 ≥ 0.4。

mood 不能单独把群聊刷成语音。

## 观测

- 记录 `voice` 决策、DeliveryPlan、实际调用工具、成功/失败、延迟。
- plan 要语音但模型未调用 → `voice_miss` trace；不自动补发。
- 来源无语音出口 → `voice_unsupported`；无文字出口 → `text_unsupported`。
