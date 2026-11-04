/**
 * SQLite 主存储。
 *
 * 设计约束：
 * - node:sqlite 同步 API；主线程只做点查、小 KNN 和短事务，批量任务交给 worker。
 * - WAL + synchronous=NORMAL + busy_timeout=250；应用层单写者队列。
 * - records 是当前视图；record_versions 保留历史；record_evidence / record_links 可审计。
 * - sqlite-vec 可选；不可用时向量写入返回 false，检索退化为 FTS/LIKE。
 * - FTS5 trigram 对少于 3 字符的中文查询不可靠，短查询回退 LIKE。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import type {
  MemoryApplyResult,
  MemoryCandidate,
  MemoryCard,
  MemoryFilter,
  MemoryKind,
  MemoryOp,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemoryStatsSummary,
  MemoryStore,
  MemoryTier,
} from './types.ts';

const require = createRequire(import.meta.url);
// 通过 createRequire 加载，避免 Vite/Vitest 把 node:sqlite 当成可解析的包。
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function vectorExtensionPath(): string | null {
  try {
    const mod = require('sqlite-vec') as { getLoadablePath?: () => string };
    return mod.getLoadablePath?.() ?? null;
  } catch {
    return null;
  }
}

export interface SqliteStoreOptions {
  path: string;
  dim: number;
  /** false 时即使扩展可用也不建向量表。 */
  vectors?: boolean;
  busyTimeoutMs?: number;
}

interface Row {
  [key: string]: unknown;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const nowIso = (): string => new Date().toISOString();
const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);
const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();
const scopeKey = (scope: MemoryScope): string => `${scope.type}${scope.id ? `:${scope.id}` : ''}`;

function newRecordId(): string {
  const stamp = Date.now().toString(36).padStart(9, '0');
  return `mem_${stamp}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function l2Normalize(vector: readonly number[]): number[] {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return [...vector];
  return vector.map((v) => v / norm);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function scopeFromRow(row: Row): MemoryScope {
  const type = asString(row.scope_type, 'global') as MemoryScope['type'];
  const id = row.scope_id == null ? undefined : String(row.scope_id);
  return id ? { type, id } : { type };
}

export class SqliteMemoryStore implements MemoryStore {
  readonly backend = 'sqlite' as const;
  readonly dim: number;
  private readonly db: DatabaseSyncType;
  private readonly statements = new Map<string, StatementSync>();
  private readonly path: string;
  private readonly wantVectors: boolean;
  private _vectorEnabled = false;
  private _ftsEnabled = false;
  private closed = false;

  constructor(opts: SqliteStoreOptions) {
    this.path = opts.path;
    this.dim = Math.max(1, Math.floor(opts.dim));
    this.wantVectors = opts.vectors !== false;
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path, { allowExtension: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${Math.max(50, opts.busyTimeoutMs ?? 250)}; PRAGMA foreign_keys=ON;`);
    this.init();
  }

  get vectorEnabled(): boolean { return this._vectorEnabled; }
  get ftsEnabled(): boolean { return this._ftsEnabled; }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private exec(sql: string): void {
    this.db.exec(sql);
  }

  private tx<T>(fn: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
      throw err;
    }
  }

  init(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        tier TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        subject TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        canonical_key TEXT,
        content_hash TEXT,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        superseded_by TEXT,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        sensitivity TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_access_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        vec_rowid INTEGER,
        affect_json TEXT
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS records_scope ON records(scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS records_status_tier ON records(status, tier);
      CREATE INDEX IF NOT EXISTS records_updated ON records(updated_at);
      CREATE INDEX IF NOT EXISTS records_hash ON records(content_hash);

      CREATE TABLE IF NOT EXISTS record_versions (
        record_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        op TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        reason TEXT,
        trace_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(record_id, version)
      );
      CREATE TABLE IF NOT EXISTS record_evidence (
        record_id TEXT NOT NULL,
        event_id TEXT,
        quote TEXT,
        at TEXT NOT NULL,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS record_evidence_record ON record_evidence(record_id);
      CREATE TABLE IF NOT EXISTS record_links (
        from_id TEXT NOT NULL,
        type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        PRIMARY KEY(from_id, type, to_id)
      );
      CREATE TABLE IF NOT EXISTS record_vectors (
        record_id TEXT PRIMARY KEY,
        vec_rowid INTEGER,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relationships (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        familiarity REAL NOT NULL DEFAULT 0,
        trust REAL NOT NULL DEFAULT 0,
        intimacy REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'neutral',
        playfulness_tolerance REAL NOT NULL DEFAULT 0.5,
        tension REAL NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope_type, scope_id)
      );
      CREATE TABLE IF NOT EXISTS mood_state (
        id TEXT PRIMARY KEY,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        energy REAL NOT NULL,
        tension REAL NOT NULL,
        openness REAL NOT NULL,
        patience REAL NOT NULL,
        playfulness REAL NOT NULL,
        focus REAL NOT NULL,
        label TEXT NOT NULL,
        causes_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention_state (
        id TEXT PRIMARY KEY,
        topics_json TEXT NOT NULL,
        threads_json TEXT NOT NULL,
        energy REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_ops (
        id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        record_id TEXT,
        payload_json TEXT NOT NULL,
        trace_id TEXT,
        created_at TEXT NOT NULL
      );
    `);

    try {
      this.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        record_id UNINDEXED, title, content, subject, tokenize='trigram'
      );`);
      this._ftsEnabled = true;
    } catch {
      this._ftsEnabled = false;
    }

    const existingDim = this.getState<number>('dim');
    const dimMatches = existingDim == null || Number(existingDim) === this.dim;
    if (this.wantVectors && dimMatches) {
      const ext = vectorExtensionPath();
      if (ext) {
        try {
          this.db.enableLoadExtension(true);
          this.db.loadExtension(ext);
          this.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_records USING vec0(
            scope text, status text, tier text, embedding float[${this.dim}] distance_metric=cosine
          );`);
          this._vectorEnabled = true;
        } catch {
          this._vectorEnabled = false;
        }
      }
    }

    this.exec(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, '${nowIso()}');`);
    this.exec(`PRAGMA user_version=1;`);
    // 维度变化时旧 vec_records 不能混用；保持 meta 里的旧值，关闭向量召回，等操作者重建。
    if (dimMatches) this.setMeta('dim', String(this.dim));
    else this._vectorEnabled = false;
    this.setMeta('vector_enabled', this._vectorEnabled ? '1' : '0');
    this.setMeta('fts_enabled', this._ftsEnabled ? '1' : '0');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ }
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  get(id: string): MemoryRecord | undefined {
    const row = this.stmt('SELECT * FROM records WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(filter: MemoryFilter = {}): MemoryRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.scope) {
      where.push('scope_type = ?');
      params.push(filter.scope.type);
      if (filter.scope.id) {
        where.push('scope_id = ?');
        params.push(filter.scope.id);
      }
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.tiers?.length) {
      where.push(`tier IN (${filter.tiers.map(() => '?').join(',')})`);
      params.push(...filter.tiers);
    }
    if (filter.sensitivity?.length) {
      where.push(`sensitivity IN (${filter.sensitivity.map(() => '?').join(',')})`);
      params.push(...filter.sensitivity);
    }
    const order = filter.orderBy === 'created' ? 'created_at'
      : filter.orderBy === 'salience' ? 'salience'
        : filter.orderBy === 'confidence' ? 'confidence' : 'updated_at';
    const sql = `SELECT * FROM records${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} DESC LIMIT ? OFFSET ?`;
    const rows = this.stmt(sql).all(...params, Math.max(1, filter.limit ?? 100), Math.max(0, filter.offset ?? 0)) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  hot(limit = 40): MemoryRecord[] {
    const rows = this.stmt(
      `SELECT * FROM records WHERE status='active' AND tier='hot' ORDER BY salience DESC, updated_at DESC LIMIT ?`,
    ).all(limit) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  search(query: MemoryQuery): MemorySearchHit[] {
    const limit = Math.max(1, query.limit ?? 20);
    const ranked = new Map<string, { record: MemoryRecord; score: number; via: Set<MemorySearchHit['via'][number]> }>();
    const add = (record: MemoryRecord, score: number, via: MemorySearchHit['via'][number]): void => {
      if (!this.visible(record, query)) return;
      const hit = ranked.get(record.id);
      if (hit) {
        hit.score += score;
        hit.via.add(via);
      } else {
        ranked.set(record.id, { record, score, via: new Set([via]) });
      }
    };
    const RRF = (rank: number): number => 1 / (60 + rank + 1);

    for (const [rank, record] of this.hot(40).entries()) add(record, RRF(rank), 'hot');

    let lexicalHits = 0;
    if (this._ftsEnabled) {
      const rows = this.ftsRows(query.text, limit * 3);
      lexicalHits = rows.length;
      for (const [rank, row] of rows.entries()) {
        const id = String(row.record_id);
        const rec = this.get(id);
        if (rec) add(rec, RRF(rank), 'fts');
      }
    }
    // 短查询或 FTS 无结果时用 LIKE 兜底（trigram 对 2 字中文不可靠）。
    if (lexicalHits === 0 && query.text.trim()) {
      const like = `%${query.text.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const rows = this.stmt(
        `SELECT * FROM records WHERE status='active' AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\') ORDER BY salience DESC LIMIT ?`,
      ).all(like, like, like, limit * 3) as Row[];
      for (const [rank, row] of rows.entries()) add(this.hydrate(row), RRF(rank), 'fts');
    }

    if (this._vectorEnabled && query.vector?.length) {
      for (const [rank, hit] of this.knn(query.vector, limit * 4).entries()) {
        const rec = this.get(hit.recordId);
        if (rec) add(rec, RRF(rank) * Math.max(0.1, hit.score), 'vector');
      }
    }

    const recent = this.stmt(
      `SELECT * FROM records WHERE status='active' AND tier IN ('hot','warm') ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit * 2) as Row[];
    for (const [rank, row] of recent.entries()) add(this.hydrate(row), RRF(rank) * 0.6, 'recency');

    return [...ranked.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({ record: h.record, score: h.score, via: [...h.via] }));
  }

  private visible(record: MemoryRecord, query: MemoryQuery): boolean {
    if (record.status !== 'active' && !query.includeInactive) return false;
    if (record.tier === 'cold' && !query.includeCold) return false;
    if (record.sensitivity === 'secret') return false;
    if (query.kinds?.length && !query.kinds.includes(record.kind)) return false;
    if (query.tiers?.length && !query.tiers.includes(record.tier)) return false;
    if (query.scope) {
      const same = record.scope.type === query.scope.type && (record.scope.id ?? '') === (query.scope.id ?? '');
      if (!same && record.scope.type !== 'global') return false;
    }
    if (record.sensitivity === 'private') {
      if (query.scope?.type !== 'person') return false;
      if (record.scope.type === 'person' && record.scope.id !== query.scope.id) return false;
    }
    if (record.valid.to) return false;
    return true;
  }

  private ftsRows(text: string, limit: number): Row[] {
    const q = this.ftsQuery(text);
    if (!q) return [];
    try {
      return this.stmt(
        `SELECT record_id, bm25(records_fts) AS score FROM records_fts WHERE records_fts MATCH ? ORDER BY score LIMIT ?`,
      ).all(q, limit) as Row[];
    } catch {
      return [];
    }
  }

  private ftsQuery(text: string): string {
    const tokens = normalizeText(text)
      .split(/[\s,，。；;:：!?！？、]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);
    if (tokens.length === 0) return '';
    return tokens.slice(0, 8).map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  }

  // -------------------------------------------------------------------------
  // 写
  // -------------------------------------------------------------------------

  apply(ops: readonly MemoryOp[], traceId = `trace_${randomUUID()}`): MemoryApplyResult {
    const result: MemoryApplyResult = {
      created: [], updated: [], merged: [], skipped: 0, deferred: 0,
      archived: [], deleted: [], explicitSkipped: 0, traceId,
    };
    this.tx(() => {
      for (const op of ops) this.applyOne(op, traceId, result);
    });
    return result;
  }

  private applyOne(op: MemoryOp, traceId: string, result: MemoryApplyResult): void {
    const now = nowIso();
    const audit = (recordId?: string): void => {
      this.stmt(
        `INSERT INTO memory_ops(id, op, record_id, payload_json, trace_id, created_at) VALUES(?,?,?,?,?,?)`,
      ).run(`op_${randomUUID()}`, op.op, recordId ?? null, JSON.stringify(op), traceId, now);
    };

    if (op.op === 'skip') {
      result.skipped++;
      if (op.candidate?.explicit) result.explicitSkipped++;
      audit(op.targetIds?.[0]);
      return;
    }
    if (op.op === 'defer') {
      result.deferred++;
      if (op.candidate?.explicit) result.explicitSkipped++;
      audit(op.targetIds?.[0]);
      return;
    }
    if (op.op === 'archive' || op.op === 'demote' || op.op === 'promote' || op.op === 'delete') {
      for (const id of op.targetIds ?? []) {
        const current = this.get(id);
        if (!current) continue;
        if (op.op === 'delete') {
          this.stmt(`UPDATE records SET status='deleted', updated_at=?, vec_rowid=NULL WHERE id=?`).run(now, id);
          this.removeIndexes(id);
          result.deleted.push(id);
        } else {
          const tier: MemoryTier = op.op === 'promote' ? (op.tier ?? 'hot')
            : op.op === 'demote' ? (op.tier ?? 'cold') : 'cold';
          const status = op.op === 'archive' ? 'archived' : current.status;
          this.stmt(`UPDATE records SET tier=?, status=?, updated_at=? WHERE id=?`).run(tier, status, now, id);
          if (tier === 'cold' || status !== 'active') this.removeIndexes(id);
          result.archived.push(id);
        }
        this.writeVersion(id, op.op, traceId, op.reason);
      }
      audit(op.targetIds?.[0]);
      return;
    }
    if (op.op === 'link') {
      const from = op.targetIds?.[0];
      if (from && op.link) {
        this.stmt(`INSERT OR REPLACE INTO record_links(from_id, type, to_id, weight) VALUES(?,?,?,?)`)
          .run(from, op.link.type, op.link.target, op.link.weight ?? 1);
      }
      audit(from);
      return;
    }

    const candidate = op.candidate;
    if (!candidate) {
      result.skipped++;
      audit();
      return;
    }

    if (op.op === 'create') {
      const existing = this.byContent(candidate);
      if (existing) {
        this.touchConfidence(existing, candidate);
        result.skipped++;
        if (candidate.explicit) result.explicitSkipped++;
        audit(existing.id);
        return;
      }
      const id = this.insert(candidate, now);
      result.created.push(id);
      audit(id);
      return;
    }

    // update / merge
    const targets = (op.targetIds ?? []).map((id) => this.get(id)).filter((r): r is MemoryRecord => !!r && r.status === 'active');
    if (targets.length === 0) {
      const id = this.insert(candidate, now);
      result.created.push(id);
      audit(id);
      return;
    }
    const survivor = targets[0]!;
    const others = targets.slice(1);
    this.mergeInto(survivor, candidate, now, op.reason, traceId);
    result.updated.push(survivor.id);
    for (const other of others) {
      this.stmt(`UPDATE records SET status='archived', superseded_by=?, updated_at=? WHERE id=?`).run(survivor.id, now, other.id);
      this.removeIndexes(other.id);
      this.writeVersion(other.id, 'merge', traceId, `merged into ${survivor.id}`);
      result.merged.push(other.id);
    }
    audit(survivor.id);
  }

  private byContent(candidate: MemoryCandidate): MemoryRecord | undefined {
    const hash = hashText(`${normalizeText(candidate.title)}\n${normalizeText(candidate.content)}`);
    const row = this.stmt(
      `SELECT * FROM records WHERE status='active' AND content_hash=? AND kind=? AND scope_type=? AND COALESCE(scope_id,'')=? LIMIT 1`,
    ).get(hash, candidate.kind, candidate.scope.type, candidate.scope.id ?? '') as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  private touchConfidence(record: MemoryRecord, candidate: MemoryCandidate): void {
    const now = nowIso();
    const confidence = Math.max(record.confidence, candidate.confidence ?? record.confidence);
    const salience = Math.max(record.salience, candidate.salience ?? record.salience);
    this.stmt(`UPDATE records SET confidence=?, salience=?, updated_at=? WHERE id=?`).run(confidence, salience, now, record.id);
    this.addEvidence(record.id, candidate);
  }

  private insert(candidate: MemoryCandidate, now: string): string {
    const id = newRecordId();
    const title = normalizeText(candidate.title);
    const content = normalizeText(candidate.content);
    const hash = hashText(`${title}\n${content}`);
    const scope = candidate.scope;
    this.stmt(`INSERT INTO records(
      id, version, kind, tier, scope_type, scope_id, subject, title, content,
      canonical_key, content_hash, valid_from, valid_to, confidence, salience,
      sensitivity, status, created_at, updated_at, access_count, use_count, affect_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,0,0,?)`).run(
      id, 1, candidate.kind, 'warm', scope.type, scope.id ?? null, candidate.subject ?? null,
      title, content, candidate.canonicalKey ?? this.canonical(candidate), hash,
      candidate.validFrom ?? now, clamp01(candidate.confidence ?? 0.6), clamp01(candidate.salience ?? 0.5),
      candidate.sensitivity, 'active', now, now,
      candidate.affect ? JSON.stringify(candidate.affect) : null,
    );
    this.addEvidence(id, candidate);
    for (const link of candidate.links ?? []) {
      this.stmt(`INSERT OR REPLACE INTO record_links(from_id, type, to_id, weight) VALUES(?,?,?,?)`)
        .run(id, link.type, link.target, link.weight ?? 1);
    }
    this.indexText(id, title, content, candidate.subject ?? '');
    this.writeVersion(id, 'create', undefined, candidate.explicit ? 'explicit' : undefined);
    return id;
  }

  private mergeInto(record: MemoryRecord, candidate: MemoryCandidate, now: string, reason?: string, traceId?: string): void {
    const title = candidate.title ? normalizeText(candidate.title) : record.title;
    const content = candidate.content ? normalizeText(candidate.content) : record.content;
    const version = record.version + 1;
    this.stmt(`UPDATE records SET version=?, title=?, content=?, kind=?, confidence=?, salience=?,
      sensitivity=?, updated_at=?, content_hash=?, canonical_key=?, vec_rowid=NULL WHERE id=?`).run(
      version, title, content, candidate.kind ?? record.kind,
      Math.max(record.confidence, clamp01(candidate.confidence ?? record.confidence)),
      Math.max(record.salience, clamp01(candidate.salience ?? record.salience)),
      this.strongerSensitivity(record.sensitivity, candidate.sensitivity), now,
      hashText(`${title}\n${content}`), candidate.canonicalKey ?? record.canonicalKey ?? this.canonical(candidate),
      record.id,
    );
    this.addEvidence(record.id, candidate);
    for (const link of candidate.links ?? []) {
      this.stmt(`INSERT OR REPLACE INTO record_links(from_id, type, to_id, weight) VALUES(?,?,?,?)`)
        .run(record.id, link.type, link.target, link.weight ?? 1);
    }
    this.removeVector(record.id);
    this.indexText(record.id, title, content, candidate.subject ?? record.subject ?? '');
    this.writeVersion(record.id, 'update', traceId, reason);
  }

  private strongerSensitivity(a: MemoryRecord['sensitivity'], b: MemoryRecord['sensitivity']): MemoryRecord['sensitivity'] {
    const rank = { normal: 0, private: 1, secret: 2 } as const;
    return rank[b] > rank[a] ? b : a;
  }

  private canonical(candidate: MemoryCandidate): string {
    return [candidate.kind, scopeKey(candidate.scope), candidate.subject ?? '', hashText(normalizeText(candidate.content))].join('|');
  }

  private addEvidence(recordId: string, candidate: MemoryCandidate): void {
    for (const e of candidate.evidence ?? []) {
      const dup = this.stmt(
        `SELECT 1 FROM record_evidence WHERE record_id=? AND COALESCE(event_id,'')=? AND COALESCE(quote,'')=? LIMIT 1`,
      ).get(recordId, e.eventId ?? '', e.quote ?? '');
      if (dup) continue;
      this.stmt(`INSERT INTO record_evidence(record_id, event_id, quote, at, source) VALUES(?,?,?,?,?)`)
        .run(recordId, e.eventId ?? null, e.quote ?? null, e.at, e.source ?? null);
    }
  }

  private indexText(id: string, title: string, content: string, subject: string): void {
    if (!this._ftsEnabled) return;
    try {
      this.stmt(`DELETE FROM records_fts WHERE record_id=?`).run(id);
      this.stmt(`INSERT INTO records_fts(record_id, title, content, subject) VALUES(?,?,?,?)`)
        .run(id, title, content, subject);
    } catch { /* FTS 失败不影响主记录 */ }
  }

  private removeIndexes(id: string): void {
    this.removeVector(id);
    if (this._ftsEnabled) {
      try { this.stmt(`DELETE FROM records_fts WHERE record_id=?`).run(id); } catch { /* ignore */ }
    }
  }

  private removeVector(id: string): void {
    const row = this.stmt(`SELECT vec_rowid FROM records WHERE id=?`).get(id) as Row | undefined;
    const vecRowid = row?.vec_rowid;
    if (this._vectorEnabled && typeof vecRowid === 'number') {
      try { this.stmt(`DELETE FROM vec_records WHERE rowid=?`).run(vecRowid); } catch { /* ignore */ }
    }
    this.stmt(`DELETE FROM record_vectors WHERE record_id=?`).run(id);
    this.stmt(`UPDATE records SET vec_rowid=NULL WHERE id=?`).run(id);
  }

  private writeVersion(id: string, op: string, traceId?: string, reason?: string): void {
    const record = this.get(id);
    if (!record) return;
    this.stmt(`INSERT OR REPLACE INTO record_versions(record_id, version, op, snapshot_json, reason, trace_id, created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, record.version, op, JSON.stringify(record), reason ?? null, traceId ?? null, nowIso());
  }

  recordAccess(ids: readonly string[], used = false): void {
    const now = nowIso();
    for (const id of ids) {
      this.stmt(`UPDATE records SET access_count=access_count+1, last_access_at=?, use_count=use_count+? WHERE id=?`)
        .run(now, used ? 1 : 0, id);
    }
  }

  forget(id: string, mode: 'soft' | 'hard'): boolean {
    const exists = this.get(id);
    if (!exists) return false;
    this.tx(() => {
      const now = nowIso();
      this.stmt(`UPDATE records SET status='deleted', updated_at=? WHERE id=?`).run(now, id);
      this.removeIndexes(id);
      this.stmt(`INSERT INTO memory_ops(id, op, record_id, payload_json, trace_id, created_at) VALUES(?,?,?,?,?,?)`)
        .run(`op_${randomUUID()}`, mode === 'hard' ? 'forget_hard' : 'forget_soft', id, JSON.stringify({ id, mode }), null, now);
      if (mode === 'hard') {
        this.stmt(`DELETE FROM records WHERE id=?`).run(id);
        this.stmt(`DELETE FROM record_evidence WHERE record_id=?`).run(id);
        this.stmt(`DELETE FROM record_links WHERE from_id=? OR to_id=?`).run(id, id);
        this.stmt(`DELETE FROM record_versions WHERE record_id=?`).run(id);
        this.stmt(`DELETE FROM record_vectors WHERE record_id=?`).run(id);
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // 向量
  // -------------------------------------------------------------------------

  upsertVector(recordId: string, vector: readonly number[], model: string): boolean {
    if (!this._vectorEnabled || vector.length !== this.dim) return false;
    const record = this.get(recordId);
    if (!record) return false;
    const normalized = l2Normalize(vector);
    return this.tx(() => {
      const previous = this.stmt(`SELECT vec_rowid FROM records WHERE id=?`).get(recordId) as Row | undefined;
      const old = previous?.vec_rowid;
      if (typeof old === 'number') {
        try { this.stmt(`DELETE FROM vec_records WHERE rowid=?`).run(old); } catch { /* ignore */ }
      }
      this.stmt(`INSERT INTO vec_records(scope, status, tier, embedding) VALUES(?,?,?,?)`)
        .run(scopeKey(record.scope), record.status, record.tier, JSON.stringify(normalized));
      const rowid = this.db.prepare('SELECT last_insert_rowid() AS id').get() as Row;
      const vecRowid = Number(rowid.id);
      this.stmt(`UPDATE records SET vec_rowid=? WHERE id=?`).run(vecRowid, recordId);
      this.stmt(`INSERT OR REPLACE INTO record_vectors(record_id, vec_rowid, model, dim) VALUES(?,?,?,?)`)
        .run(recordId, vecRowid, model, this.dim);
      return true;
    });
  }

  knn(vector: readonly number[], k: number): Array<{ recordId: string; score: number }> {
    if (!this._vectorEnabled || vector.length !== this.dim) return [];
    const normalized = l2Normalize(vector);
    const rows = this.stmt(
      `SELECT rowid, distance FROM vec_records WHERE embedding MATCH ? AND k = ?`,
    ).all(JSON.stringify(normalized), Math.max(1, Math.floor(k))) as Row[];
    const out: Array<{ recordId: string; score: number }> = [];
    for (const row of rows) {
      const rec = this.stmt(`SELECT id FROM records WHERE vec_rowid=? LIMIT 1`).get(Number(row.rowid)) as Row | undefined;
      if (!rec?.id) continue;
      out.push({ recordId: String(rec.id), score: clamp01(1 - asNumber(row.distance, 1)) });
    }
    return out;
  }

  missingEmbedding(limit = 32): MemoryRecord[] {
    const rows = this.stmt(
      `SELECT * FROM records WHERE status='active' AND tier IN ('hot','warm') AND vec_rowid IS NULL ORDER BY salience DESC LIMIT ?`,
    ).all(limit) as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  // -------------------------------------------------------------------------
  // 状态 / 统计 / 维护
  // -------------------------------------------------------------------------

  getState<T>(key: string): T | undefined {
    const row = this.stmt(`SELECT value FROM memory_meta WHERE key=?`).get(key) as Row | undefined;
    if (!row?.value) return undefined;
    try { return JSON.parse(String(row.value)) as T; } catch { return undefined; }
  }

  setState(key: string, value: unknown): void {
    this.stmt(`INSERT INTO memory_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(value));
  }

  private setMeta(key: string, value: string): void {
    this.stmt(`INSERT OR REPLACE INTO memory_meta(key, value) VALUES(?,?)`).run(key, value);
  }

  stats(): MemoryStatsSummary {
    const total = Number((this.stmt(`SELECT COUNT(*) AS n FROM records`).get() as Row).n ?? 0);
    const active = Number((this.stmt(`SELECT COUNT(*) AS n FROM records WHERE status='active'`).get() as Row).n ?? 0);
    const byTier: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0 };
    for (const row of this.stmt(`SELECT tier, COUNT(*) AS n FROM records WHERE status='active' GROUP BY tier`).all() as Row[]) {
      byTier[String(row.tier) as MemoryTier] = Number(row.n ?? 0);
    }
    const byKind: Partial<Record<MemoryKind, number>> = {};
    for (const row of this.stmt(`SELECT kind, COUNT(*) AS n FROM records WHERE status='active' GROUP BY kind`).all() as Row[]) {
      byKind[String(row.kind) as MemoryKind] = Number(row.n ?? 0);
    }
    const byScope: Record<string, number> = {};
    for (const row of this.stmt(`SELECT scope_type, COALESCE(scope_id,'') AS sid, COUNT(*) AS n FROM records WHERE status='active' GROUP BY scope_type, scope_id`).all() as Row[]) {
      byScope[`${row.scope_type}${row.sid ? `:${row.sid}` : ''}`] = Number(row.n ?? 0);
    }
    const hotRows = this.stmt(`SELECT title, content FROM records WHERE status='active' AND tier='hot'`).all() as Row[];
    const hotChars = hotRows.reduce((n, row) => n + String(row.title ?? '').length + String(row.content ?? '').length, 0);
    let dbBytes = 0;
    if (this.path !== ':memory:' && existsSync(this.path)) {
      try { dbBytes = statSync(this.path).size; } catch { dbBytes = 0; }
    }
    return {
      total, active, byTier, byKind, byScope,
      hotTokensEstimate: Math.ceil(hotChars / 3),
      dbBytes, vectorEnabled: this._vectorEnabled, ftsEnabled: this._ftsEnabled, dim: this.dim,
    };
  }

  exportJsonl(path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const records = this.list({ limit: 1_000_000, orderBy: 'created' });
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    return records.length;
  }

  backup(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const escaped = path.replace(/'/g, "''");
    this.exec(`VACUUM INTO '${escaped}'`);
  }

  // -------------------------------------------------------------------------
  // 映射
  // -------------------------------------------------------------------------

  private hydrate(row: Row): MemoryRecord {
    const id = String(row.id);
    const evidenceRows = this.stmt(`SELECT event_id, quote, at, source FROM record_evidence WHERE record_id=? ORDER BY at`).all(id) as Row[];
    const linkRows = this.stmt(`SELECT type, to_id, weight FROM record_links WHERE from_id=?`).all(id) as Row[];
    const affect = row.affect_json ? safeJson(row.affect_json) as MemoryRecord['affect'] : undefined;
    return {
      id,
      version: asNumber(row.version, 1),
      kind: String(row.kind) as MemoryKind,
      tier: String(row.tier) as MemoryTier,
      scope: scopeFromRow(row),
      subject: row.subject == null ? undefined : String(row.subject),
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
      canonicalKey: row.canonical_key == null ? undefined : String(row.canonical_key),
      contentHash: row.content_hash == null ? undefined : String(row.content_hash),
      evidence: evidenceRows.map((e) => ({
        eventId: e.event_id == null ? undefined : String(e.event_id),
        quote: e.quote == null ? undefined : String(e.quote),
        at: String(e.at),
        source: e.source == null ? undefined : String(e.source),
      })),
      valid: {
        from: String(row.valid_from),
        to: row.valid_to == null ? undefined : String(row.valid_to),
      },
      supersededBy: row.superseded_by == null ? undefined : String(row.superseded_by),
      confidence: asNumber(row.confidence),
      salience: asNumber(row.salience),
      sensitivity: String(row.sensitivity) as MemoryRecord['sensitivity'],
      affect,
      links: linkRows.map((l) => ({
        type: String(l.type) as MemoryRecord['links'][number]['type'],
        target: String(l.to_id),
        weight: asNumber(l.weight, 1),
      })),
      embedding: row.vec_rowid == null ? undefined : { model: '', dim: this.dim, vecRowid: asNumber(row.vec_rowid) },
      status: String(row.status) as MemoryRecord['status'],
      stats: {
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastAccessAt: row.last_access_at == null ? undefined : String(row.last_access_at),
        accessCount: asNumber(row.access_count),
        useCount: asNumber(row.use_count),
      },
    };
  }
}

function safeJson(value: unknown): unknown {
  try { return JSON.parse(String(value)); } catch { return undefined; }
}

export function memoryCard(record: MemoryRecord): MemoryCard {
  return {
    id: record.id,
    kind: record.kind,
    tier: record.tier,
    scope: record.scope,
    subject: record.subject,
    title: record.title,
    content: record.content,
    confidence: record.confidence,
    salience: record.salience,
    validFrom: record.valid.from,
    updatedAt: record.stats.updatedAt,
    source: record.evidence[0]?.source ?? record.evidence[0]?.eventId,
  };
}
