# ADR 0005: 语音只决定发/不发，路由按来源

- 状态：接受（2026-11-03）
- 背景：未来不止 QQ 一个输入输出 World；让决策模型选 local/QQ/其他会耦合渠道。
- 决定：`TurnPlan.voice` 是布尔；`ChannelRouter` 按事件来源和该 World 的 speak 工具生成 `DeliveryPlan`。
- 理由：信息来源决定回复路径；控制台语音不误发 QQ；其他 World 用自己的工具。
- 代价：未知 World 可能没有语音/文字出口；需要显式 `voice_unsupported` / `text_unsupported`。
- 缓解：没有出口就不发；文字仍走来源渠道；不跨渠道退回。
