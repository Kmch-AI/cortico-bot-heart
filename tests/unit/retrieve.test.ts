import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../memory/sqlite.ts';
import { retrieveMemories, buildQueryText, formatMemoryCards } from '../../memory/retrieve.ts';
import { writeCandidate } from '../../memory/write.ts';
import { DecisionPlane } from '../../decision/fallback.ts';
import type { MemoryCandidate } from '../../memory/types.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { testConfig } from '../helpers.ts';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: 'preference',
    scope: { type: 'person', id: 'u1' },
    title: '喜欢喝美式',
    content: '他早上通常喝美式，不加糖。',
    evidence: [{ eventId: 'e1', quote: '我早上都喝美式', at: '2026-11-01T08:00:00.000Z' }],
    sensitivity: 'normal',
    ...overrides,
  };
}

const event: EventEnvelope = {
  cursor: 1, type: 'qq.message', ts: '2026-11-04T10:00:00.000Z', source: 'qq', origin: 'external',
  text: '早上喝什么咖啡比较好？',
};

describe('retrieval', () => {
  it('builds a deterministic query and retrieves a relevant card', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 16, vectors: false });
    store.apply([{ op: 'create', candidate: candidate() }]);
    const cfg = testConfig();
    const result = await retrieveMemories({
      events: [event],
      mood: { valence: 0.1, arousal: 0.3, energy: 0.6, tension: 0.1, openness: 0.6, patience: 0.6, playfulness: 0.3, focus: 0.5, label: '平静', causes: [], updatedAt: '' },
      attention: { topics: ['咖啡'], threads: [], pending: [], energy: 0.6, lastSpeakers: [], updatedAt: '' },
      delivery: { source: 'qq', text: 'qq', voice: 'qq', target: 'private:u1', textAvailable: true, voiceAvailable: true },
      scope: { type: 'person', id: 'u1' },
    }, {
      store,
      topK: cfg.retrieval.topK,
      rerankTopN: cfg.retrieval.rerankTopN,
      tokenBudget: cfg.retrieval.tokenBudget,
      mmrLambda: cfg.retrieval.mmrLambda,
      abstainThreshold: 0.1,
    });
    expect(buildQueryText({
      events: [event],
      mood: { valence: 0.1, arousal: 0.3, energy: 0.6, tension: 0.1, openness: 0.6, patience: 0.6, playfulness: 0.3, focus: 0.5, label: '平静', causes: [], updatedAt: '' },
      attention: { topics: [], threads: [], pending: [], energy: 0.6, lastSpeakers: [], updatedAt: '' },
      delivery: { source: 'qq', text: 'qq', voice: null, textAvailable: true, voiceAvailable: false },
    })).toContain('咖啡');
    expect(result.cards.length).toBeGreaterThan(0);
    expect(formatMemoryCards(result.cards)).toContain('[M:');
    store.close();
  });

  it('abstains when nothing is relevant', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 16, vectors: false });
    const result = await retrieveMemories({
      events: [event],
      mood: { valence: 0.1, arousal: 0.3, energy: 0.6, tension: 0.1, openness: 0.6, patience: 0.6, playfulness: 0.3, focus: 0.5, label: '平静', causes: [], updatedAt: '' },
      attention: { topics: [], threads: [], pending: [], energy: 0.6, lastSpeakers: [], updatedAt: '' },
      delivery: { source: 'qq', text: 'qq', voice: null, textAvailable: true, voiceAvailable: false },
    }, {
      store, topK: 8, rerankTopN: 20, tokenBudget: 500, mmrLambda: 0.7, abstainThreshold: 2,
    });
    expect(result.cards).toHaveLength(0);
    store.close();
  });
});

describe('write pipeline', () => {
  it('creates once then skips an exact duplicate', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 16, vectors: false });
    const decision = new DecisionPlane({ client: null, timeoutMs: 100, confidenceThreshold: 0.5 });
    const first = await writeCandidate(candidate(), { store, decision, warmLimit: 5000 });
    expect(first.applied.created).toHaveLength(1);
    const second = await writeCandidate(candidate(), { store, decision, warmLimit: 5000 });
    expect(second.applied.created).toHaveLength(0);
    expect(second.decision.op).toBe('skip');
    store.close();
  });

  it('puts identity candidates in the review queue instead of writing them', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 16, vectors: false });
    const decision = new DecisionPlane({ client: null, timeoutMs: 100, confidenceThreshold: 0.5 });
    const result = await writeCandidate(candidate({ kind: 'identity', title: '我是谁', content: '我把自己当作一个会犹豫的人。' }), {
      store, decision, warmLimit: 5000,
    });
    expect(result.decision.op).toBe('defer');
    expect(store.stats().active).toBe(0);
    expect(store.getState<unknown[]>('identity:pending')).toHaveLength(1);
    store.close();
  });

  it('keeps explicit candidates in the audit when skipped', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 16, vectors: false });
    const decision = new DecisionPlane({ client: null, timeoutMs: 100, confidenceThreshold: 0.5 });
    await writeCandidate(candidate(), { store, decision, warmLimit: 5000 });
    const explicit = await writeCandidate(candidate({ explicit: true }), { store, decision, warmLimit: 5000 });
    expect(explicit.decision.op).toBe('skip');
    expect(explicit.applied.explicitSkipped).toBe(1);
    store.close();
  });
});
