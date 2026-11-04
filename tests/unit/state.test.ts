import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../memory/sqlite.ts';
import { MoodEngine } from '../../state/mood.ts';
import { AttentionEngine } from '../../state/attention.ts';
import { RelationshipEngine } from '../../state/relationship.ts';
import { testConfig } from '../helpers.ts';

function store(): SqliteMemoryStore {
  return new SqliteMemoryStore({ path: ':memory:', dim: 8, vectors: false });
}

describe('state engines', () => {
  it('moves mood toward appraisal and decays back toward baseline', () => {
    const s = store();
    const cfg = testConfig();
    const mood = new MoodEngine({
      store: s,
      baseline: cfg.mood.baseline,
      inertia: cfg.mood.inertia,
      halfLifeMinutes: cfg.mood.halfLifeMinutes,
    });
    const before = mood.current(new Date('2026-11-04T10:00:00Z'));
    expect(before.label).toBeTruthy();
    const next = mood.appraise({
      valence: 0.9, arousal: 0.9, energy: 0.8, tension: 0.4,
      importance: 0.8, relationshipDelta: 0.6, reason: 'test',
    }, 'e1', new Date('2026-11-04T10:00:00Z'));
    expect(next.valence).toBeGreaterThan(before.valence);
    expect(next.causes[0]?.reason).toBe('test');
    const later = mood.current(new Date('2026-11-04T12:00:00Z'));
    expect(Math.abs(later.valence - cfg.mood.baseline.valence)).toBeLessThan(Math.abs(next.valence - cfg.mood.baseline.valence));
    s.close();
  });

  it('stores relationship deltas with derived status', () => {
    const s = store();
    const rel = new RelationshipEngine(s);
    const scope = { type: 'person' as const, id: 'u1' };
    const a = rel.update(scope, { familiarity: 0.6, trust: 0.5, intimacy: 0.7 });
    expect(a.status).toBe('close');
    expect(rel.get(scope).intimacy).toBeCloseTo(0.8, 3);
    s.close();
  });

  it('tracks attention topics and pending threads', () => {
    const s = store();
    const attention = new AttentionEngine({ store: s });
    attention.observe({ text: '你明天有空吗？想去看电影', source: 'qq', sender: 'u1', addressed: true });
    const state = attention.current();
    expect(state.threads.length).toBeGreaterThan(0);
    expect(state.topics.length).toBeGreaterThan(0);
    attention.defer('明天再说', 'qq');
    expect(attention.consumePending()).toHaveLength(1);
    s.close();
  });
});
