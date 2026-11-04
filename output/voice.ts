import type { HeartConfig } from '../config.ts';
import type { DeliveryPlan } from './route.ts';
import type { TurnPlan } from './turnPlan.ts';

export interface VoiceGateInput {
  plan: TurnPlan;
  route: DeliveryPlan;
  cfg: HeartConfig['voice'];
  isPrivate: boolean;
  isGroup: boolean;
  explicitRequested: boolean;
  /** 最近一次发语音距今的回合数；null 表示没发过。 */
  turnsSinceVoice: number | null;
  /** 当前情绪强度 0..1，由 mood/relationship 推导。 */
  emotionalIntensity: number;
}

export interface VoiceGateResult {
  send: boolean;
  reason: string;
}

/**
 * 只决定“发 / 不发”。发到哪里已经由 ChannelRouter 按来源定好。
 * 默认保守：群聊不因心情单独开语音；没有语音出口一律 false。
 */
export function gateVoice(input: VoiceGateInput): VoiceGateResult {
  const { plan, route, cfg } = input;
  if (!plan.voice) return { send: false, reason: 'decision: no voice' };
  if (!cfg.enabled) return { send: false, reason: 'config: voice disabled' };
  if (!route.voiceAvailable) return { send: false, reason: 'route: voice_unsupported' };
  if (cfg.maxPerTurns > 0 && input.turnsSinceVoice !== null && input.turnsSinceVoice < cfg.maxPerTurns) {
    return { send: false, reason: `rate: last voice ${input.turnsSinceVoice} turns ago` };
  }
  if (input.explicitRequested) return { send: true, reason: 'explicit request' };
  if (input.isPrivate) {
    return { send: input.emotionalIntensity >= 0.25, reason: input.emotionalIntensity >= 0.25 ? 'private + affect' : 'private but low affect' };
  }
  if (input.isGroup) {
    if (!cfg.groupDefault && input.emotionalIntensity < 0.65) {
      return { send: false, reason: 'group default off' };
    }
    return { send: true, reason: cfg.groupDefault ? 'group default on' : 'group high affect' };
  }
  return { send: input.emotionalIntensity >= 0.4, reason: 'source policy' };
}

export function isExplicitVoiceRequest(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

export function emotionalIntensity(plan: TurnPlan, mood: { valence: number; arousal: number; tension: number; playfulness: number }): number {
  const extremes = Math.max(Math.abs(mood.valence), mood.arousal, mood.tension, mood.playfulness);
  return Math.max(0, Math.min(1, extremes * 0.7 + plan.playfulness * 0.3));
}
