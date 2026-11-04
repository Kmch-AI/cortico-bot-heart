# 零成本沉默：Core drop

## 现状

stock Core 的 `Persona.onDelivery` 返回值被忽略，`deliveryGate` 只能扣留/放行，不能丢弃。
heart 0.1 在 stock Core 上使用**语义沉默**：

```
[attention] 这一批不值得回应。不要输出正文，不要调用发送工具，直接 end_turn。
```

主模型仍会运行一次。这是不破坏事件语义的沉默方式；不要把事件从上下文删掉或伪造“没看见”。

`persona/coreCompat.ts` 会探测 Core 是否暴露 `deliveryDrop` 能力；0.1 只记录日志，不改变返回类型。

## 目标契约（独立 Core PR）

```ts
type DeliveryDecision = { action: 'deliver' } | { action: 'drop'; reason: string };
onDelivery?(ctx): void | DeliveryDecision | Promise<void | DeliveryDecision>;
```

Core 在 `onDelivery` 返回 `drop` 后：

- 不写 session、不进入 `rounds()`、不调主模型；
- 仍 `noteHandled` 推进 watermark，避免事件永远卡住；
- 给 World 新的结算结果 `dropped`（建议 `onEventsSettled(..., 'dropped')`），区分“Persona 看过但不回”和“操作者清空队列”；
- Persona 在返回 drop 前可以把事件放进记忆包，所以“看过但没说”仍可被记住；
- 写 audit，记录 reason 与事件游标。

## 实现评估

- 不是一行补丁；主要改真实项目 `D:\AI\Cortico\src\core\loop.ts`、`D:\AI\Cortico\src\core\types.ts`。
- 需要事件结算/watermark 测试，以及 World 端 `dropped` 结果的处理。
- 适合独立 PR；不适合塞进 heart 包。
- 上游不接受时，继续语义沉默，或在 QQ World 加粗过滤（只按 @/回复/关键词，不懂 mood/记忆）。

## 插件层替代方案

| 方案 | 问题 |
|---|---|
| `onDelivery` 返回值 | 当前被忽略 |
| `deliveryGate` | 只能扣留/放行，不能丢弃 |
| `BotParts.llm` 伪造空 Response | 绕过用量、流式、协议；不做 |
| QQ World 粗过滤 | 不懂 mood/记忆，丢失上下文；只作附加降噪 |
