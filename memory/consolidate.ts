/**
 * 巩固：确定性的合并、分层与容量控制。
 *
 * 语义总结（多条 episode → 一条 semantic）需要后台 fork，0.1 先做不依赖模型的部分：
 * 完全相同/同 canonicalKey 的合并、identity/relationship/commitment 升 hot、超限 warm 冷化。
 */
import type { MemoryCandidate, MemoryOp, MemoryRecord, MemoryStore } from './types.ts';

export interface ConsolidationOptions {
  store: MemoryStore;
  warmLimit: number;
  /** 多少天没访问且低 salience 的 warm 降到 cold。 */
  coldAfterDays?: number;
  now?: Date;
}

export interface ConsolidationResult {
  merged: number;
  promoted: number;
  demoted: number;
  archived: number;
}

function candidateFrom(record: MemoryRecord): MemoryCandidate {
  return {
    kind: record.kind,
    scope: record.scope,
    subject: record.subject,
    title: record.title,
    content: record.content,
    evidence: record.evidence,
    validFrom: record.valid.from,
    sensitivity: record.sensitivity,
    confidence: record.confidence,
    salience: record.salience,
    canonicalKey: record.canonicalKey,
    links: record.links,
    affect: record.affect,
  };
}

export function consolidate(opts: ConsolidationOptions): ConsolidationResult {
  const now = opts.now ?? new Date();
  const records = opts.store.list({ status: ['active'], limit: 100_000, orderBy: 'created' });
  const result: ConsolidationResult = { merged: 0, promoted: 0, demoted: 0, archived: 0 };
  const ops: MemoryOp[] = [];

  // 1. 同 canonicalKey 或同内容 hash 合并。保留 salience/confidence 更高、更早的记录。
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = record.canonicalKey ?? record.contentHash ?? record.id;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.salience + b.confidence) - (a.salience + a.confidence));
    const keep = group[0]!;
    for (const other of group.slice(1)) {
      ops.push({ op: 'merge', candidate: candidateFrom(other), targetIds: [keep.id], reason: 'consolidation duplicate' });
      result.merged++;
    }
  }

  // 2. identity / relationship / commitment 升 hot；warm 超限时冷化最低分。
  for (const record of records) {
    if (record.tier !== 'hot' && (record.kind === 'identity' || record.kind === 'relationship' || record.kind === 'commitment')
      && (record.salience >= 0.7 || record.kind === 'identity')) {
      ops.push({ op: 'promote', targetIds: [record.id], tier: 'hot', reason: 'consolidation promote' });
      result.promoted++;
    }
  }
  const warm = records.filter((r) => r.tier === 'warm');
  if (warm.length > opts.warmLimit) {
    const excess = warm.length - opts.warmLimit;
    const candidates = warm
      .filter((r) => r.kind !== 'identity' && r.kind !== 'relationship' && r.kind !== 'commitment')
      .sort((a, b) => (a.salience + a.confidence) - (b.salience + b.confidence));
    const coldAfter = opts.coldAfterDays ?? 45;
    for (const record of candidates.slice(0, excess)) {
      const ageDays = (now.getTime() - Date.parse(record.stats.updatedAt)) / 86_400_000;
      if (record.salience < 0.35 || ageDays > coldAfter) {
        ops.push({ op: 'demote', targetIds: [record.id], tier: 'cold', reason: 'consolidation capacity' });
        result.demoted++;
      }
    }
  }

  if (ops.length > 0) opts.store.apply(ops, `consolidate_${now.toISOString()}`);
  return result;
}
