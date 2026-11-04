# ADR 0004: 零成本沉默走独立 Core PR

- 状态：提议（2026-11-03）
- 背景：stock Core 忽略 `onDelivery` 返回值；`deliveryGate` 不能丢弃。
- 决定：heart 0.1 用语义沉默；另开 Core PR 增加 `onDelivery` drop 与 `dropped` 结算。
- 理由：插件层替代方案会伪造 Response、绕过用量/流式/协议，或丢失上下文。
- 代价：语义沉默仍消耗一次主模型调用；Core PR 可能不被上游接受。
- 缓解：`coreCompat.ts` 探测能力；不接受时继续语义沉默或 QQ 粗过滤。
