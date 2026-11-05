# ADR 0004: 沉默只走语义沉默

- 状态：已定（2026-11-04 更新；原 Core drop 提议被上游拒绝）
- 背景：stock Core 忽略 `Persona.onDelivery` 返回值；`deliveryGate` 只能扣留/放行，不能丢弃。
- 决定：heart 的 silence/defer 一律注入“不要回应”的内部说明，让主模型跑一次并自行 `end_turn`。删除 `persona/coreCompat.ts`、`silence.mode` 与所有 `{ action: 'drop' }` 返回。
- 上游结论：Core PR [#371](https://github.com/Pal-AI-Lab/Cortico/pull/371) 已关闭。维护者的分工是：Persona 决定事件怎么摆给模型看（注入提示、交接时留哪些、用 `deliveryGate` 扣住再一起放行），但模型有没有看到事件、要不要回应，归主模型自己。整批丢弃会让主模型看不到事件，回不回由别的模型替它决定。
- 建议替代：继续语义沉默；想少叫醒主模型时，用 `deliveryGate` 扣住事件，按点名、积压数量或自己的定时器放行。事件不会丢，只是延后。
- 禁止：不得用 provider 伪造模型回复来跳过调用。扩展市场把这类做法视为改语义，会被拉黑。
- 代价：语义沉默仍消耗一次主模型调用；前缀命中缓存时成本不高。
