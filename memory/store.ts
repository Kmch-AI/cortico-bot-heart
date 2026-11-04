/**
 * 存储工厂：优先 SQLite；`node:sqlite` 不可用或 backend=jsonl 时退回 JSONL + 内存索引。
 * JSONL 是降级路径，不追求并发与规模；启动时会明确告警。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SqliteMemoryStore } from './sqlite.ts';
import type {
  MemoryApplyResult,
  MemoryCandidate,
  MemoryFilter,
  MemoryOp,
  MemoryQuery,
  MemoryRecord,
  MemorySearchHit,
  MemoryStatsSummary,
  MemoryStore,
} from './types.ts';

export interface CreateStoreOptions {
  dir: string;
  backend: 'auto' | 'sqlite' | 'jsonl';
  dim: number;
  vectors?: boolean;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

export function createMemoryStore(opts: CreateStoreOptions): MemoryStore {
  mkdirSync(opts.dir, { recursive: true });
  if (opts.backend === 'sqlite' || opts.backend === 'auto') {
    try {
      return new SqliteMemoryStore({ path: join(opts.dir, 'heart.db'), dim: opts.dim, vectors: opts.vectors });
    } catch (err) {
      if (opts.backend === 'sqlite') throw err;
      opts.logger?.warn(`SQLite 不可用，退回 JSONL：${(err as Error)?.message ?? err}`);
    }
  }
  opts.logger?.warn('使用 JSONL 降级存储：检索能力与并发能力下降。');
  return new JsonlMemoryStore(join(opts.dir, 'records.jsonl'), join(opts.dir, 'state.json'), opts.dim);
}

const nowIso = (): string => new Date().toISOString();
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export class JsonlMemoryStore implements MemoryStore {
  readonly backend = 'jsonl' as const;
  readonly ftsEnabled = false;
  readonly dim: number;
  private records = new Map<string, MemoryRecord>();
  private states: Record<string, unknown> = {};
  private vectors = new Map<string, { vector: number[]; model: string }>();
  private closed = false;

  constructor(private readonly recordsPath: string, private readonly statePath: string, dim: number) {
    this.dim = Math.max(1, Math.floor(dim));
    this.init();
  }

  get vectorEnabled(): boolean { return true; }

  init(): void {
    if (existsSync(this.recordsPath)) {
      for (const line of readFileSync(this.recordsPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as MemoryRecord;
          if (record?.id) this.records.set(record.id, record);
        } catch { /* 跳过损坏行，保留其余数据 */ }
      }
    }
    if (existsSync(this.statePath)) {
      try { this.states = JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, unknown>; } catch { this.states = {}; }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private flush(): void {
    mkdirSync(dirname(this.recordsPath), { recursive: true });
    const lines = [...this.records.values()].map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(this.recordsPath, lines + (lines ? '\n' : ''), 'utf8');
    writeFileSync(this.statePath, JSON.stringify(this.states), 'utf8');
  }

  get(id: string): MemoryRecord | undefined {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  list(filter: MemoryFilter = {}): MemoryRecord[] {
    let out = [...this.records.values()];
    if (filter.status?.length) out = out.filter((r) => filter.status!.includes(r.status));
    if (filter.scope) out = out.filter((r) => r.scope.type === filter.scope!.type && (r.scope.id ?? '') === (filter.scope!.id ?? ''));
    if (filter.kinds?.length) out = out.filter((r) => filter.kinds!.includes(r.kind));
    if (filter.tiers?.length) out = out.filter((r) => filter.tiers!.includes(r.tier));
    if (filter.sensitivity?.length) out = out.filter((r) => filter.sensitivity!.includes(r.sensitivity));
    const order = filter.orderBy ?? 'updated';
    out.sort((a, b) => order === 'salience' ? b.salience - a.salience
      : order === 'confidence' ? b.confidence - a.confidence
        : order === 'created' ? a.stats.createdAt.localeCompare(b.stats.createdAt)
          : b.stats.updatedAt.localeCompare(a.stats.updatedAt));
    const offset = Math.max(0, filter.offset ?? 0);
    return out.slice(offset, offset + Math.max(1, filter.limit ?? 100)).map((r) => structuredClone(r));
  }

  hot(limit = 40): MemoryRecord[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'active' && r.tier === 'hot')
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  search(query: MemoryQuery): MemorySearchHit[] {
    const limit = Math.max(1, query.limit ?? 20);
    const text = query.text.toLowerCase();
    const scored = new Map<string, { record: MemoryRecord; score: number; via: Set<MemorySearchHit['via'][number]> }>();
    const add = (record: MemoryRecord, score: number, via: MemorySearchHit['via'][number]): void => {
      if (!this.visible(record, query)) return;
      const hit = scored.get(record.id);
      if (hit) { hit.score += score; hit.via.add(via); }
      else scored.set(record.id, { record: structuredClone(record), score, via: new Set([via]) });
    };
    this.hot().forEach((r, i) => add(r, 1 / (60 + i + 1), 'hot'));
    if (text.trim()) {
      for (const record of this.records.values()) {
        const haystack = `${record.title} ${record.content} ${record.subject ?? ''}`.toLowerCase();
        if (haystack.includes(text)) add(record, 0.5, 'fts');
        else if (text.split(/\s+/).some((t) => t.length >= 2 && haystack.includes(t))) add(record, 0.2, 'fts');
      }
    }
    if (query.vector?.length) {
      for (const [i, hit] of this.knn(query.vector, limit * 4).entries()) {
        const r = this.records.get(hit.recordId);
        if (r) add(r, (1 / (60 + i + 1)) * Math.max(0.1, hit.score), 'vector');
      }
    }
    return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit)
      .map((h) => ({ record: h.record, score: h.score, via: [...h.via] }));
  }

  private visible(r: MemoryRecord, q: MemoryQuery): boolean {
    if (r.status !== 'active' && !q.includeInactive) return false;
    if (r.tier === 'cold' && !q.includeCold) return false;
    if (r.sensitivity === 'secret') return false;
    if (q.kinds?.length && !q.kinds.includes(r.kind)) return false;
    if (q.tiers?.length && !q.tiers.includes(r.tier)) return false;
    if (r.valid.to) return false;
    if (r.sensitivity === 'private') {
      if (q.scope?.type !== 'person') return false;
      if (r.scope.type === 'person' && r.scope.id !== q.scope.id) return false;
    }
    return true;
  }

  apply(ops: readonly MemoryOp[], traceId = `trace_${Date.now()}`): MemoryApplyResult {
    const result: MemoryApplyResult = {
      created: [], updated: [], merged: [], skipped: 0, deferred: 0,
      archived: [], deleted: [], explicitSkipped: 0, traceId,
    };
    for (const op of ops) {
      if (op.op === 'skip' || op.op === 'defer') {
        if (op.op === 'skip') result.skipped++; else result.deferred++;
        if (op.candidate?.explicit) result.explicitSkipped++;
        continue;
      }
      if (op.op === 'delete') {
        for (const id of op.targetIds ?? []) {
          if (this.records.delete(id)) result.deleted.push(id);
          this.vectors.delete(id);
        }
        continue;
      }
      if (op.op === 'archive' || op.op === 'demote' || op.op === 'promote') {
        for (const id of op.targetIds ?? []) {
          const r = this.records.get(id);
          if (!r) continue;
          r.tier = op.op === 'promote' ? (op.tier ?? 'hot') : (op.tier ?? 'cold');
          if (op.op === 'archive') r.status = 'archived';
          r.stats.updatedAt = nowIso();
          result.archived.push(id);
        }
        continue;
      }
      if (op.op === 'link') {
        const from = op.targetIds?.[0];
        const r = from ? this.records.get(from) : undefined;
        if (r && op.link && !r.links.some((l) => l.type === op.link!.type && l.target === op.link!.target)) {
          r.links.push(op.link);
        }
        continue;
      }
      const candidate = op.candidate;
      if (!candidate) { result.skipped++; continue; }
      const existing = op.op === 'create'
        ? [...this.records.values()].find((r) => r.status === 'active' && r.contentHash === hashCandidate(candidate))
        : op.targetIds?.map((id) => this.records.get(id)).find((r) => r && r.status === 'active');
      if (existing) {
        existing.title = candidate.title;
        existing.content = candidate.content;
        existing.confidence = Math.max(existing.confidence, clamp01(candidate.confidence ?? existing.confidence));
        existing.salience = Math.max(existing.salience, clamp01(candidate.salience ?? existing.salience));
        existing.stats.updatedAt = nowIso();
        existing.version++;
        for (const e of candidate.evidence) {
          if (!existing.evidence.some((old) => old.eventId === e.eventId && old.quote === e.quote)) existing.evidence.push(e);
        }
        result.updated.push(existing.id);
        continue;
      }
      const id = `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const at = nowIso();
      const record: MemoryRecord = {
        id, version: 1, kind: candidate.kind, tier: 'warm', scope: candidate.scope,
        subject: candidate.subject, title: candidate.title, content: candidate.content,
        canonicalKey: candidate.canonicalKey, contentHash: hashCandidate(candidate),
        evidence: candidate.evidence, valid: { from: candidate.validFrom ?? at },
        confidence: clamp01(candidate.confidence ?? 0.6), salience: clamp01(candidate.salience ?? 0.5),
        sensitivity: candidate.sensitivity, affect: candidate.affect, links: candidate.links ?? [],
        status: 'active', stats: { createdAt: at, updatedAt: at, accessCount: 0, useCount: 0 },
      };
      this.records.set(id, record);
      result.created.push(id);
    }
    this.flush();
    return result;
  }

  recordAccess(ids: readonly string[], used = false): void {
    for (const id of ids) {
      const r = this.records.get(id);
      if (!r) continue;
      r.stats.accessCount++;
      r.stats.lastAccessAt = nowIso();
      if (used) r.stats.useCount++;
    }
    this.flush();
  }

  stats(): MemoryStatsSummary {
    const active = [...this.records.values()].filter((r) => r.status === 'active');
    const byTier = { hot: 0, warm: 0, cold: 0 };
    const byKind: Partial<Record<MemoryRecord['kind'], number>> = {};
    const byScope: Record<string, number> = {};
    for (const r of active) {
      byTier[r.tier]++;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      const key = `${r.scope.type}${r.scope.id ? `:${r.scope.id}` : ''}`;
      byScope[key] = (byScope[key] ?? 0) + 1;
    }
    const hotChars = active.filter((r) => r.tier === 'hot').reduce((n, r) => n + r.title.length + r.content.length, 0);
    return {
      total: this.records.size, active: active.length, byTier, byKind, byScope,
      hotTokensEstimate: Math.ceil(hotChars / 3), dbBytes: 0,
      vectorEnabled: true, ftsEnabled: false, dim: this.dim,
    };
  }

  exportJsonl(path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const records = [...this.records.values()];
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    return records.length;
  }

  backup(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(this.recordsPath)) copyFileSync(this.recordsPath, path);
  }

  forget(id: string, mode: 'soft' | 'hard'): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    if (mode === 'hard') {
      this.records.delete(id);
      this.vectors.delete(id);
    } else {
      r.status = 'deleted';
      r.stats.updatedAt = nowIso();
    }
    this.flush();
    return true;
  }

  upsertVector(recordId: string, vector: readonly number[], model: string): boolean {
    if (vector.length !== this.dim || !this.records.has(recordId)) return false;
    this.vectors.set(recordId, { vector: normalize([...vector]), model });
    return true;
  }

  knn(vector: readonly number[], k: number): Array<{ recordId: string; score: number }> {
    if (vector.length !== this.dim) return [];
    const q = normalize([...vector]);
    return [...this.vectors.entries()]
      .map(([recordId, v]) => ({ recordId, score: cosine(q, v.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, k));
  }

  missingEmbedding(limit = 32): MemoryRecord[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'active' && (r.tier === 'hot' || r.tier === 'warm') && !this.vectors.has(r.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  getState<T>(key: string): T | undefined {
    return this.states[key] as T | undefined;
  }

  setState(key: string, value: unknown): void {
    this.states[key] = value;
    this.flush();
  }
}

function hashCandidate(candidate: MemoryCandidate): string {
  return `${candidate.title}\n${candidate.content}`.replace(/\s+/g, ' ').trim();
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(0, Math.min(1, dot));
}
