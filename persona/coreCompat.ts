/**
 * Core drop 能力探测。
 *
 * stock Core 的 `Persona.onDelivery` 返回值被忽略；独立 Core PR 通过后，Core 会暴露一个
 * 能力标志并接受 `{ action: 'drop', reason }`。heart 不假设它存在，也不伪造“没看见”：
 * 没有 drop 时走语义沉默，主模型仍会跑一次。
 */
import type { CoreApi } from 'cortico/core/types.ts';

export type DeliveryDecision = { action: 'deliver' } | { action: 'drop'; reason: string };

export interface DeliveryDropCapability {
  deliveryDrop?: boolean;
  capabilities?: { deliveryDrop?: boolean };
}

export function supportsDeliveryDrop(core: CoreApi | null | undefined): boolean {
  if (!core) return false;
  const c = core as unknown as DeliveryDropCapability;
  return c.deliveryDrop === true || c.capabilities?.deliveryDrop === true;
}

/**
 * 未来 Core PR 的返回类型。0.1 不把它放进 `Persona.onDelivery` 的签名，
 * 因为 stock Core 的类型仍是 `void | Promise<void>`；等 Core 契约升级后直接替换。
 */
export type DroppableDeliveryHook = (ctx: { events: unknown[] }) => void | DeliveryDecision | Promise<void | DeliveryDecision>;
