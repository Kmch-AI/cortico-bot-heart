import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from '../../memory/sqlite.ts';
import type { MemoryCandidate } from '../../memory/types.ts';

function candidate(title: string, content: string): MemoryCandidate {
  return {
    kind: 'semantic', scope: { type: 'global' }, title, content,
    evidence: [{ at: '2026-11-04T00:00:00.000Z' }], sensitivity: 'normal',
  };
}

describe('sqlite-vec optional path', () => {
  it('indexes hot/warm vectors and returns nearest neighbours when available', () => {
    const store = new SqliteMemoryStore({ path: ':memory:', dim: 4, vectors: true });
    if (!store.vectorEnabled) {
      store.close();
      return; // 平台没有 sqlite-vec：降级路径由 jsonl/词法测试覆盖。
    }
    const a = store.apply([{ op: 'create', candidate: candidate('猫', '猫喜欢晒太阳') }]).created[0]!;
    const b = store.apply([{ op: 'create', candidate: candidate('雨', '今天下雨了') }]).created[0]!;
    expect(store.upsertVector(a, [1, 0, 0, 0], 'test')).toBe(true);
    expect(store.upsertVector(b, [0, 1, 0, 0], 'test')).toBe(true);
    const hits = store.knn([0.9, 0.1, 0, 0], 2);
    expect(hits[0]?.recordId).toBe(a);
    expect(hits[1]?.recordId).toBe(b);
    expect(store.missingEmbedding()).toHaveLength(0);
    store.close();
  });
});
