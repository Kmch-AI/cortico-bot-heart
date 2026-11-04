import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../memory/sqlite.ts';
import type { MemoryCandidate } from '../../memory/types.ts';

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

describe('SqliteMemoryStore', () => {
  it('creates, reads, searches and dedupes records', () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 8, vectors: false });
    const created = store.apply([{ op: 'create', candidate: candidate() }]);
    expect(created.created).toHaveLength(1);
    const record = store.get(created.created[0]!);
    expect(record?.title).toBe('喜欢喝美式');
    expect(record?.evidence[0]?.quote).toContain('美式');

    const hits = store.search({ text: '美式', limit: 5 });
    expect(hits.some((h) => h.record.id === record!.id)).toBe(true);

    // 完全相同的内容再写入一次：不新增，只更新置信度/证据。
    const again = store.apply([{ op: 'create', candidate: candidate({ confidence: 0.9 }) }]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toBe(1);
    store.close();
  });

  it('merges into a target and keeps versions', () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 8, vectors: false });
    const id = store.apply([{ op: 'create', candidate: candidate() }]).created[0]!;
    const merged = store.apply([{
      op: 'merge',
      candidate: candidate({ title: '早上喝美式', content: '他早上通常喝美式，不加糖；偶尔换成拿铁。' }),
      targetIds: [id],
    }]);
    expect(merged.updated).toContain(id);
    const record = store.get(id)!;
    expect(record.version).toBe(2);
    expect(record.content).toContain('拿铁');
    expect(record.evidence.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it('applies private visibility rules', () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 8, vectors: false });
    store.apply([{ op: 'create', candidate: candidate({ sensitivity: 'private', scope: { type: 'person', id: 'u1' } }) }]);
    expect(store.search({ text: '美式', scope: { type: 'group', id: 'g1' } })).toHaveLength(0);
    expect(store.search({ text: '美式', scope: { type: 'person', id: 'u2' } })).toHaveLength(0);
    expect(store.search({ text: '美式', scope: { type: 'person', id: 'u1' } }).length).toBeGreaterThan(0);
    store.close();
  });

  it('stores small state and exports', () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 8, vectors: false });
    store.setState('mood', { valence: 0.2 });
    expect(store.getState<{ valence: number }>('mood')?.valence).toBe(0.2);
    expect(store.stats().active).toBe(0);
    store.close();
  });
});
