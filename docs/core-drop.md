# 零成本沉默：Core drop

## 现状

支持 `CoreApi.deliveryDrop` 的 Core 允许 `Persona.onDelivery` 返回：

```ts
type DeliveryDecision = { action: 'deliver' } | { action: 'drop'; reason: string };
onDelivery?(ctx): void | DeliveryDecision | Promise<void | DeliveryDecision>;
```

Core 收到 `drop` 后：

- 不写 session、不进入 `rounds()`、不调主模型；
- `noteHandled` 推进 watermark，重启不会补投；
- 钩子期间 `injectInternal` 的内部项一并丢弃；
- 来源 World 的 `onEventsSettled(..., 'dropped')` 收到 `dropped`；
- 写 audit 日志，含 reason、事件数与来源，不写正文。

heart 在 `attach` 时探测 `core.deliveryDrop`。`silence.mode`：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | Core 支持就 drop，否则语义沉默 |
| `semantic` | 始终注入“不要回应”，让主模型跑一次并 `end_turn` |
| `core-drop` | 要求 drop；Core 不支持时告警一次并回退语义沉默 |

drop 前 `flushPacket()` 把事件交给记忆 worker，所以“看过但没说”仍会被提取；`onBatchEnd`
不会运行，heart 同时补 `turns++`。心情与注意力由随后运行的 `onIdle` 推进。

参考 Core 实现分支：`D:\AI\Cortico` 的 `feat/persona-delivery-drop`（未合入主线前，
发布依赖的 stock Core 仍走语义沉默）。

## 历史

stock Core 0.2.12 的 `onDelivery` 返回值被忽略，`deliveryGate` 只能扣留/放行，不能丢弃。
heart 0.1 因此先实现语义沉默，并用 `persona/coreCompat.ts` 探测未来能力；Core 分支合入后
无需改 heart 的调用点。

## 插件层替代方案

| 方案 | 问题 |
|---|---|
| `deliveryGate` | 只能扣留/放行，不能丢弃 |
| `BotParts.llm` 伪造空 Response | 绕过用量、流式、协议；不做 |
| QQ World 粗过滤 | 不懂 mood/记忆，丢失上下文；只作附加降噪 |
