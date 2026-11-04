/**
 * 心情状态：慢变量，不随每句话重置。
 *
 * 更新规则来自设计 §5.1：
 *   mood' = clamp(baseline + inertia * (mood - baseline) + impulse)
 * 半衰期只负责向基线回落；极端值有上限，避免一次互动永久改人。
 */
import type { MemoryStore } from '../memory/types.ts';
import type { Appraisal } from '../decision/types.ts';

export type MoodDimension = 'valence' | 'arousal' | 'energy' | 'tension' | 'openness' | 'patience' | 'playfulness' | 'focus';

export interface MoodCause {
  eventId?: string;
  reason: string;
  at: string;
}

export interface MoodState {
  valence: number;
  arousal: number;
  energy: number;
  tension: number;
  openness: number;
  patience: number;
  playfulness: number;
  focus: number;
  label: string;
  causes: MoodCause[];
  updatedAt: string;
}

export interface MoodBaseline {
  valence: number;
  arousal: number;
  energy: number;
  tension: number;
  openness: number;
  patience: number;
  playfulness: number;
  focus: number;
}

export interface MoodEngineOptions {
  store: MemoryStore;
  baseline: MoodBaseline;
  inertia: number;
  halfLifeMinutes: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const clampValence = (n: number): number => Math.max(-1, Math.min(1, n));
const nowIso = (): string => new Date().toISOString();

function baselineState(baseline: MoodBaseline, at: string): MoodState {
  return {
    ...baseline,
    label: '平静',
    causes: [],
    updatedAt: at,
  };
}

function decayToward(current: number, baseline: number, halfLifeMinutes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return current;
  const halfLives = elapsedMs / (halfLifeMinutes * 60_000);
  const factor = Math.pow(0.5, halfLives);
  return baseline + (current - baseline) * factor;
}

function labelFor(m: Omit<MoodState, 'label' | 'causes' | 'updatedAt'>): string {
  if (m.valence < -0.35 && m.arousal > 0.55) return '有点冲';
  if (m.valence < -0.25) return '不太高兴';
  if (m.tension > 0.65) return '绷着';
  if (m.energy < 0.3) return '有点累';
  if (m.valence > 0.45 && m.arousal > 0.55) return '兴致很高';
  if (m.valence > 0.3 && m.playfulness > 0.55) return '心情不错';
  if (m.valence > 0.2) return '平静偏暖';
  if (m.openness < 0.35) return '不太想接新话题';
  return '平静';
}

export class MoodEngine {
  private state: MoodState;
  private readonly store: MemoryStore;
  private readonly baseline: MoodBaseline;
  private readonly inertia: number;
  private readonly halfLifeMinutes: number;

  constructor(opts: MoodEngineOptions) {
    this.store = opts.store;
    this.baseline = opts.baseline;
    this.inertia = Math.max(0, Math.min(1, opts.inertia));
    this.halfLifeMinutes = Math.max(1, opts.halfLifeMinutes);
    const saved = this.store.getState<MoodState>('mood');
    this.state = saved ? { ...baselineState(opts.baseline, saved.updatedAt), ...saved } : baselineState(opts.baseline, nowIso());
  }

  current(now = new Date()): MoodState {
    const elapsed = now.getTime() - Date.parse(this.state.updatedAt);
    if (!Number.isFinite(elapsed) || elapsed <= 0) return { ...this.state };
    const next: MoodState = {
      ...this.state,
      valence: clampValence(decayToward(this.state.valence, this.baseline.valence, this.halfLifeMinutes, elapsed)),
      arousal: clamp01(decayToward(this.state.arousal, this.baseline.arousal, this.halfLifeMinutes, elapsed)),
      energy: clamp01(decayToward(this.state.energy, this.baseline.energy, this.halfLifeMinutes, elapsed)),
      tension: clamp01(decayToward(this.state.tension, this.baseline.tension, this.halfLifeMinutes, elapsed)),
      openness: clamp01(decayToward(this.state.openness, this.baseline.openness, this.halfLifeMinutes, elapsed)),
      patience: clamp01(decayToward(this.state.patience, this.baseline.patience, this.halfLifeMinutes, elapsed)),
      playfulness: clamp01(decayToward(this.state.playfulness, this.baseline.playfulness, this.halfLifeMinutes, elapsed)),
      focus: clamp01(decayToward(this.state.focus, this.baseline.focus, this.halfLifeMinutes, elapsed)),
      updatedAt: now.toISOString(),
    };
    next.label = labelFor(next);
    return next;
  }

  appraise(appraisal: Appraisal, eventId?: string, now = new Date()): MoodState {
    const current = this.current(now);
    const impulse = (value: number, scale = 0.25): number => (value - 0.5) * scale;
    const next: MoodState = {
      ...current,
      valence: clampValence(
        this.baseline.valence + this.inertia * (current.valence - this.baseline.valence) + appraisal.valence * 0.35,
      ),
      arousal: clamp01(this.baseline.arousal + this.inertia * (current.arousal - this.baseline.arousal) + impulse(appraisal.arousal, 0.3)),
      energy: clamp01(this.baseline.energy + this.inertia * (current.energy - this.baseline.energy) + impulse(appraisal.energy, 0.25)),
      tension: clamp01(this.baseline.tension + this.inertia * (current.tension - this.baseline.tension) + impulse(appraisal.tension, 0.3)),
      openness: clamp01(current.openness + (appraisal.valence > 0.2 ? 0.03 : -0.02)),
      patience: clamp01(current.patience + (appraisal.importance > 0.7 ? -0.04 : 0.01)),
      playfulness: clamp01(this.baseline.playfulness + this.inertia * (current.playfulness - this.baseline.playfulness) + impulse(appraisal.arousal, 0.2)),
      focus: clamp01(current.focus + (appraisal.importance > 0.6 ? 0.06 : -0.01)),
      causes: [
        { eventId, reason: appraisal.reason, at: now.toISOString() },
        ...current.causes,
      ].slice(0, 6),
      updatedAt: now.toISOString(),
    };
    next.label = labelFor(next);
    this.state = next;
    this.store.setState('mood', next);
    return next;
  }

  set(state: MoodState): void {
    this.state = { ...state };
    this.store.setState('mood', this.state);
  }

  /** 定时或 idle 时调用；只在变化超过阈值时写库，避免无意义唤醒/写入。 */
  tick(now = new Date()): MoodState {
    const next = this.current(now);
    const changed = Math.abs(next.valence - this.state.valence) > 0.01
      || Math.abs(next.energy - this.state.energy) > 0.01
      || next.label !== this.state.label;
    this.state = next;
    if (changed) this.store.setState('mood', next);
    return next;
  }
}

export function moodCard(mood: MoodState): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  return [
    `心情：${mood.label}`,
    `愉悦 ${mood.valence.toFixed(2)} · 激活 ${pct(mood.arousal)} · 能量 ${pct(mood.energy)} · 紧张 ${pct(mood.tension)}`,
    `开放 ${pct(mood.openness)} · 耐心 ${pct(mood.patience)} · 玩心 ${pct(mood.playfulness)} · 专注 ${pct(mood.focus)}`,
  ].join('\n');
}
