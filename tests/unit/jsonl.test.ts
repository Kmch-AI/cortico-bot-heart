import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../memory/store.ts';
import type { MemoryCandidate } from '../../memory/types.ts';
import { tempDir } from '../helpers.ts';

function candidate(): MemoryCandidate {
  return {
    kind: 'semantic', scope: { type: 'global' }, title: '测试记忆', content: '这是一条用于降级路径的记忆。',
    evidence: [{ at: '2026-11-04T00:00:00.000Z' }], sensitivity: 'normal',
  };
}

describe('JSONL fallback store', () => {
  it('creates, searches, persists state and reloads', () => {
    const tmp = tempDir();
    try {
      const store = createMemoryStore({ dir: tmp.dir, backend: 'jsonl', dim: 4 });
      expect(store.backend).toBe('jsonl');
      const id = store.apply([{ op: 'create', candidate: candidate() }]).created[0]!;
      expect(store.get(id)?.title).toBe('测试记忆');
      expect(store.search({ text: '降级', limit: 5 }).length).toBeGreaterThan(0);
      store.setState('mood', { valence: 0.1 });
      store.close();

      const again = createMemoryStore({ dir: tmp.dir, backend: 'jsonl', dim: 4 });
      expect(again.get(id)?.title).toBe('测试记忆');
      expect(again.getState<{ valence: number }>('mood')?.valence).toBe(0.1);
      again.close();
    } finally {
      tmp.cleanup();
    }
  });
});
