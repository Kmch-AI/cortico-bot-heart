/**
 * 保存流水线：候选 → 去重/邻居 → SystemOne 保存决策 → 确定性回退 → SQLite 事务。
 *
 * fork 只提议；这里重新校验并应用。显式候选被 skip 时仍写审计，不向用户编造“记住了”。
 */
import type { DecisionPlane } from '../decision/fallback.ts';
import type { MemoryApplyResult, MemoryCandidate, MemoryOp, MemoryRecord, MemoryStore, MemoryWriteDecision } from './types.ts';
import type { EmbeddingService } from './vectors.ts';

export interface WriteOptions {
  store: MemoryStore;
  decision?: DecisionPlane | null;
  embedding?: EmbeddingService | null;
  warmLimit: number;
  hotLimit?: number;
  /** 相似度达到此值时直接合并，不再调用 SystemOne。 */
  mergeThreshold?: number;
  /** bot 自己的名字/自称；用来区分“核心身份”和“关于某人的事实”。 */
  selfNames?: readonly string[];
}

export interface WriteResult {
  applied: MemoryApplyResult;
  decision: MemoryWriteDecision;
  candidate: MemoryCandidate;
  neighbors: MemoryRecord[];
}

function contentKey(candidate: MemoryCandidate): string {
  return `${candidate.title}\n${candidate.content}`.replace(/\s+/g, ' ').trim();
}

/**
 * 核心身份 = bot 自己的、全局的自述。关于用户/他人的“名字、身份、资料”是 semantic 事实，
 * 不能因为模型选了 identity 就卡进人工待审队列；这是 0.1.1 里记忆写不进去的主因。
 */
function normalizeIdentity(candidate: MemoryCandidate, selfNames: readonly string[]): MemoryCandidate {
  if (candidate.kind !== 'identity') return candidate;
  if (candidate.scope.type !== 'global') return { ...candidate, kind: 'semantic' };
  const subject = candidate.subject?.trim().toLowerCase();
  if (!subject) return candidate;
  const self = selfNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  // 单字简称只做精确匹配，避免“小心”这类普通词被当成 bot 自称。
  const aboutSelf = self.some((name) => subject === name
    || (name.length >= 3 && (subject.includes(name) || name.includes(subject))));
  return aboutSelf ? candidate : { ...candidate, kind: 'semantic' };
}

function heuristicDecision(candidate: MemoryCandidate, neighbors: readonly MemoryRecord[]): MemoryWriteDecision {
  const exact = neighbors.find((r) => r.title === candidate.title && r.content === candidate.content);
  if (exact) {
    return { save: false, op: 'skip', targetIds: [exact.id], confidence: 0.9, salience: candidate.salience ?? 0.5, reason: 'exact duplicate' };
  }
  const similar = neighbors[0];
  if (similar && (similar.title === candidate.title || similar.content === candidate.content)) {
    return { save: true, op: 'merge', targetIds: [similar.id], confidence: 0.7, salience: candidate.salience ?? 0.5, reason: 'near duplicate' };
  }
  return { save: true, op: 'create', targetIds: [], confidence: candidate.confidence ?? 0.6, salience: candidate.salience ?? 0.5, reason: 'heuristic create' };
}

export async function writeCandidate(raw: MemoryCandidate, opts: WriteOptions): Promise<WriteResult> {
  const candidate = normalizeIdentity(raw, opts.selfNames ?? []);

  // 密钥/令牌即使被显式要求也永不落库；只留审计。
  if (candidate.sensitivity === 'secret') {
    const applied = opts.store.apply([{ op: 'skip', candidate, reason: 'secret material is never stored' }]);
    return {
      applied,
      decision: { save: false, op: 'skip', targetIds: [], confidence: candidate.confidence ?? 0.6, salience: candidate.salience ?? 0.5, reason: 'secret material is never stored' },
      candidate,
      neighbors: [],
    };
  }

  // 核心身份不能由后台自动改写；先进入待审队列，由 Memory 页批准后再走正常保存。
  if (candidate.kind === 'identity' && candidate.approved !== true) {
    const pending = opts.store.getState<MemoryCandidate[]>('identity:pending') ?? [];
    pending.push({ ...candidate, approved: false });
    opts.store.setState('identity:pending', pending.slice(-20));
    const applied = opts.store.apply([{ op: 'defer', candidate, reason: 'identity review required' }]);
    return {
      applied,
      decision: { save: false, op: 'defer', targetIds: [], confidence: candidate.confidence ?? 0.6, salience: candidate.salience ?? 0.5, reason: 'identity review required' },
      candidate,
      neighbors: [],
    };
  }
  const query = contentKey(candidate);
  const hits = opts.store.search({ text: query, limit: 8 });
  const neighbors = hits.map((h) => h.record);
  const exact = neighbors.find((r) => r.title === candidate.title && r.content === candidate.content);
  let decision: MemoryWriteDecision | null = null;
  if (!exact && candidate.approved !== true && opts.decision?.available) {
    decision = await opts.decision.memoryWrite(candidate, neighbors, {
      warm: opts.store.stats().active,
      hot: opts.store.stats().byTier.hot,
    });
  }
  const heuristic = heuristicDecision(candidate, neighbors);
  // 用户明确说“记住”时，SystemOne 的 skip/defer 不能把候选吞掉；精确重复仍由 heuristic 去重。
  if (candidate.explicit && (!decision || !decision.save || decision.op === 'skip' || decision.op === 'defer')) {
    decision = {
      ...heuristic,
      reason: `${heuristic.reason}; explicit request overrides ${decision?.reason ?? 'no decision'}`,
    };
  }
  decision ??= heuristic;

  // 显式候选即使被 skip 也要保留候选与决策 trace；apply 里会写 audit。
  if (!decision.save || decision.op === 'skip') {
    const applied = opts.store.apply([{ op: 'skip', candidate, targetIds: decision.targetIds, reason: decision.reason }]);
    return { applied, decision, candidate, neighbors };
  }

  const op: MemoryOp = {
    op: decision.op === 'update' || decision.op === 'merge' ? decision.op : 'create',
    candidate: {
      ...candidate,
      confidence: decision.confidence,
      salience: decision.salience,
    },
    targetIds: decision.targetIds,
    reason: decision.reason,
  };
  const applied = opts.store.apply([op]);
  if (opts.embedding) {
    const ids = [...applied.created, ...applied.updated];
    for (const id of ids) {
      const record = opts.store.get(id);
      if (!record) continue;
      const vectors = await opts.embedding.embed([contentKey(candidate)]).catch(() => null);
      if (vectors?.[0]) opts.store.upsertVector(id, vectors[0], 'embedding');
    }
    // 后台补当前库中缺向量的记录，限制数量，避免一次请求做太多。
    for (const record of opts.store.missingEmbedding(8)) {
      const vectors = await opts.embedding.embed([`${record.title}\n${record.content}`]).catch(() => null);
      if (vectors?.[0]) opts.store.upsertVector(record.id, vectors[0], 'embedding');
    }
  }
  return { applied, decision, candidate, neighbors };
}

export function summaryOf(result: MemoryApplyResult): string {
  const parts: string[] = [];
  if (result.created.length) parts.push(`新增 ${result.created.length} 条`);
  if (result.updated.length) parts.push(`更新 ${result.updated.length} 条`);
  if (result.merged.length) parts.push(`合并 ${result.merged.length} 条`);
  if (result.skipped) parts.push(`跳过 ${result.skipped} 条`);
  if (result.deferred) parts.push(`暂存 ${result.deferred} 条`);
  return parts.length ? `记忆已整理：${parts.join('，')}。` : '';
}
