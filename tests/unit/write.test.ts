import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlMemoryStore } from '../../memory/store.ts';
import { writeCandidate } from '../../memory/write.ts';
import type { MemoryCandidate } from '../../memory/types.ts';
import type { DecisionPlane } from '../../decision/fallback.ts';
import { tempDir } from '../helpers.ts';

function store(): JsonlMemoryStore {
  const { dir } = tempDir('heart-write-');
  return new JsonlMemoryStore(join(dir, 'records.jsonl'), join(dir, 'state.json'), 8);
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: 'identity',
    scope: { type: 'person', id: 'console' },
    subject: '空空',
    title: '用户姓名：空空',
    content: '控制台用户的名字是空空。',
    evidence: [{ at: new Date().toISOString(), quote: '记住我叫空空' }],
    sensitivity: 'normal',
    explicit: true,
    ...overrides,
  };
}

const skippingDecision = {
  available: true,
  memoryWrite: async () => ({ save: false, op: 'skip' as const, targetIds: [], confidence: 0.2, salience: 0.2, reason: 'systemone skip' }),
} as unknown as DecisionPlane;

describe('memory write', () => {
  it('stores a person-scoped identity candidate as a semantic fact, not a pending core identity', async () => {
    const db = store();
    const result = await writeCandidate(candidate(), { store: db, decision: null, warmLimit: 100, selfNames: ['Kmch AI · 心', '心'] });
    expect(result.candidate.kind).toBe('semantic');
    expect(result.applied.created).toHaveLength(1);
    expect(db.list()).toHaveLength(1);
    expect(db.getState('identity:pending')).toBeUndefined();
  });

  it('keeps a global self-definition in the identity review queue', async () => {
    const db = store();
    const result = await writeCandidate(candidate({ scope: { type: 'global' }, subject: undefined, title: '我的名字', content: '我叫心。' }), {
      store: db, decision: null, warmLimit: 100, selfNames: ['Kmch AI · 心', '心'],
    });
    expect(result.candidate.kind).toBe('identity');
    expect(result.applied.deferred).toBe(1);
    expect(db.list()).toHaveLength(0);
    expect((db.getState<MemoryCandidate[]>('identity:pending') ?? [])).toHaveLength(1);
  });

  it('lets an explicit request override a SystemOne skip', async () => {
    const db = store();
    const result = await writeCandidate(candidate({ kind: 'semantic', title: '用户喜欢绿茶', content: '用户喜欢喝绿茶。' }), {
      store: db, decision: skippingDecision, warmLimit: 100, selfNames: ['心'],
    });
    expect(result.applied.created).toHaveLength(1);
    expect(result.decision.reason).toContain('explicit request overrides');
  });

  it('never stores secret material', async () => {
    const db = store();
    const result = await writeCandidate(candidate({ kind: 'semantic', sensitivity: 'secret', title: 'API key', content: 'sk-test' }), {
      store: db, decision: null, warmLimit: 100, selfNames: ['心'],
    });
    expect(result.applied.skipped).toBe(1);
    expect(db.list()).toHaveLength(0);
  });

  it('deduplicates an explicit repeat instead of creating a second record', async () => {
    const db = store();
    const opts = { store: db, decision: null, warmLimit: 100, selfNames: ['心'] };
    await writeCandidate(candidate({ kind: 'semantic', title: '用户喜欢绿茶', content: '用户喜欢喝绿茶。' }), opts);
    const again = await writeCandidate(candidate({ kind: 'semantic', title: '用户喜欢绿茶', content: '用户喜欢喝绿茶。' }), opts);
    expect(again.applied.created).toHaveLength(0);
    expect(db.list()).toHaveLength(1);
  });
});
