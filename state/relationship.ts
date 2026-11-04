/**
 * 关系状态：按 person:<id> / group:<id> 存。
 *
 * 关系变化只由有证据的互动或巩固更新；不从单句推测敏感属性。这里提供确定性的增量与渲染，
 * 判断“这句话是否改变关系”的语义工作由 SystemOne / 巩固 fork 做。
 */
import type { MemoryScope, MemoryStore } from '../memory/types.ts';

export type RelationshipStatus = 'stranger' | 'acquaintance' | 'friendly' | 'close' | 'strained' | 'neutral';

export interface RelationshipState {
  scope: MemoryScope;
  familiarity: number;
  trust: number;
  intimacy: number;
  status: RelationshipStatus;
  playfulnessTolerance: number;
  tension: number;
  summary: string;
  updatedAt: string;
}

export interface RelationshipDelta {
  familiarity?: number;
  trust?: number;
  intimacy?: number;
  tension?: number;
  playfulnessTolerance?: number;
  status?: RelationshipStatus;
  summary?: string;
  reason?: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const nowIso = (): string => new Date().toISOString();

function key(scope: MemoryScope): string {
  return `relationship:${scope.type}:${scope.id ?? ''}`;
}

function defaultState(scope: MemoryScope): RelationshipState {
  return {
    scope,
    familiarity: 0.1,
    trust: 0.3,
    intimacy: 0.1,
    status: 'neutral',
    playfulnessTolerance: 0.5,
    tension: 0,
    summary: '',
    updatedAt: nowIso(),
  };
}

export class RelationshipEngine {
  constructor(private readonly store: MemoryStore) {}

  get(scope: MemoryScope): RelationshipState {
    return this.store.getState<RelationshipState>(key(scope)) ?? defaultState(scope);
  }

  update(scope: MemoryScope, delta: RelationshipDelta): RelationshipState {
    const current = this.get(scope);
    const next: RelationshipState = {
      ...current,
      familiarity: clamp01(current.familiarity + (delta.familiarity ?? 0)),
      trust: clamp01(current.trust + (delta.trust ?? 0)),
      intimacy: clamp01(current.intimacy + (delta.intimacy ?? 0)),
      tension: clamp01(current.tension + (delta.tension ?? 0)),
      playfulnessTolerance: clamp01(current.playfulnessTolerance + (delta.playfulnessTolerance ?? 0)),
      status: delta.status ?? current.status,
      summary: delta.summary ?? current.summary,
      updatedAt: nowIso(),
    };
    // 关系标签由数值决定，避免单个 delta 直接写一个夸张状态。
    if (!delta.status) next.status = deriveStatus(next);
    this.store.setState(key(scope), next);
    return next;
  }

  /** 巩固时整体替换；只允许有证据的摘要进来。 */
  set(scope: MemoryScope, state: RelationshipState): void {
    this.store.setState(key(scope), { ...state, scope, updatedAt: nowIso() });
  }

  top(): RelationshipState[] {
    // 状态键存在 memory_meta；SQLite 不暴露前缀扫描，这里由 Persona 维护最近关系列表。
    const ids = this.store.getState<string[]>('relationship:index') ?? [];
    return ids.map((id) => {
      const [type, ...rest] = id.split(':');
      const scope: MemoryScope = { type: (type || 'person') as MemoryScope['type'], id: rest.join(':') || undefined };
      return this.get(scope);
    }).sort((a, b) => (b.familiarity + b.intimacy) - (a.familiarity + a.intimacy));
  }

  remember(scope: MemoryScope): void {
    const id = `${scope.type}:${scope.id ?? ''}`;
    const index = this.store.getState<string[]>('relationship:index') ?? [];
    if (!index.includes(id)) {
      this.store.setState('relationship:index', [...index, id].slice(-50));
    }
  }
}

function deriveStatus(state: RelationshipState): RelationshipStatus {
  if (state.tension > 0.65) return 'strained';
  if (state.intimacy > 0.65 && state.trust > 0.6) return 'close';
  if (state.familiarity > 0.55 && state.trust > 0.5) return 'friendly';
  if (state.familiarity > 0.3) return 'acquaintance';
  return state.status === 'neutral' ? 'neutral' : state.status;
}

export function relationshipCard(state: RelationshipState): string {
  const name = state.scope.id ? `${state.scope.type}:${state.scope.id}` : state.scope.type;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const summary = state.summary ? `；${state.summary}` : '';
  return `关系 ${name}：${state.status}，熟悉 ${pct(state.familiarity)}，信任 ${pct(state.trust)}，亲近 ${pct(state.intimacy)}，张力 ${pct(state.tension)}${summary}`;
}
