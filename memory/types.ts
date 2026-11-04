/**
 * Memory 的数据契约。
 *
 * 这里是 heart 的持久真源形状：SQLite 表、JSONL 导出、检索卡片和记忆工具都围绕这些类型。
 * 不在这里放行为；写入、检索、巩固各自在自己的模块里。
 */

export type MemoryKind =
  | 'identity'
  | 'relationship'
  | 'preference'
  | 'semantic'
  | 'episodic'
  | 'procedural'
  | 'commitment'
  | 'affective'
  | 'goal';

export type MemoryTier = 'hot' | 'warm' | 'cold';

export type MemoryStatus = 'active' | 'archived' | 'deleted';

export type MemorySensitivity = 'normal' | 'private' | 'secret';

export interface MemoryScope {
  type: 'global' | 'person' | 'group' | 'thread';
  id?: string;
}

export interface MemoryEvidence {
  eventId?: string;
  quote?: string;
  at: string;
  /** 来源渠道，如 qq:group:123；与 scope 分开，审计时才需要。 */
  source?: string;
}

export interface MemoryLink {
  type: 'entity' | 'topic' | 'causal' | 'supports' | 'contradicts' | 'depends';
  target: string;
  weight?: number;
}

export interface MemoryEmbedding {
  model: string;
  dim: number;
  vecRowid?: number;
}

export interface MemoryStats {
  createdAt: string;
  updatedAt: string;
  lastAccessAt?: string;
  accessCount: number;
  useCount: number;
}

export interface MemoryRecord {
  id: string;
  version: number;
  kind: MemoryKind;
  tier: MemoryTier;
  scope: MemoryScope;
  subject?: string;
  title: string;
  content: string;
  canonicalKey?: string;
  contentHash?: string;
  evidence: MemoryEvidence[];
  valid: { from: string; to?: string };
  supersedes?: string[];
  supersededBy?: string;
  confidence: number;
  salience: number;
  sensitivity: MemorySensitivity;
  affect?: { valence: number; arousal: number };
  links: MemoryLink[];
  embedding?: MemoryEmbedding;
  status: MemoryStatus;
  stats: MemoryStats;
}

/** 后台提取或 memory_note 交给保存决策的候选；没有 id，尚未落库。 */
export interface MemoryCandidate {
  kind: MemoryKind;
  scope: MemoryScope;
  subject?: string;
  title: string;
  content: string;
  evidence: MemoryEvidence[];
  validFrom?: string;
  sensitivity: MemorySensitivity;
  /** 用户明确说“记住”时置 true；被 skip 也要留审计。 */
  explicit?: boolean;
  confidence?: number;
  salience?: number;
  canonicalKey?: string;
  links?: MemoryLink[];
  affect?: { valence: number; arousal: number };
}

export type MemoryWriteOp =
  | 'create'
  | 'update'
  | 'merge'
  | 'skip'
  | 'defer'
  | 'archive'
  | 'promote'
  | 'demote'
  | 'delete'
  | 'link';

/** fork 只能提交这些结构化操作；SQLite 的写入由 MemoryStore 校验并执行。 */
export interface MemoryOp {
  op: MemoryWriteOp;
  candidate?: MemoryCandidate;
  targetIds?: string[];
  tier?: MemoryTier;
  link?: MemoryLink;
  reason?: string;
  traceId?: string;
}

export interface MemoryWriteDecision {
  save: boolean;
  op: 'create' | 'update' | 'merge' | 'skip' | 'defer';
  targetIds: string[];
  confidence: number;
  salience: number;
  reason: string;
}

export interface MemoryQuery {
  text: string;
  /** 调用方已算好的查询向量；缺省时只用词法/元数据召回。 */
  vector?: readonly number[];
  scope?: MemoryScope;
  kinds?: MemoryKind[];
  tiers?: MemoryTier[];
  limit?: number;
  /** false 时只取 active；审计/历史查询才设 true。 */
  includeInactive?: boolean;
  /** 显式查询 cold；默认检索不自动取 cold。 */
  includeCold?: boolean;
  now?: Date;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  kinds?: MemoryKind[];
  tiers?: MemoryTier[];
  status?: MemoryStatus[];
  sensitivity?: MemorySensitivity[];
  limit?: number;
  offset?: number;
  orderBy?: 'updated' | 'created' | 'salience' | 'confidence';
}

export interface MemoryCard {
  id: string;
  kind: MemoryKind;
  tier: MemoryTier;
  scope: MemoryScope;
  subject?: string;
  title: string;
  content: string;
  confidence: number;
  salience: number;
  validFrom: string;
  updatedAt: string;
  source?: string;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  score: number;
  /** 命中来源，用于 trace 与调试。 */
  via: Array<'hot' | 'fts' | 'vector' | 'link' | 'recency'>;
}

export interface MemoryApplyResult {
  created: string[];
  updated: string[];
  merged: string[];
  skipped: number;
  deferred: number;
  archived: string[];
  deleted: string[];
  /** 被 skip 的显式候选仍写审计；这里给 WebUI 与 trace 看。 */
  explicitSkipped: number;
  traceId: string;
}

export interface MemoryStatsSummary {
  total: number;
  active: number;
  byTier: Record<MemoryTier, number>;
  byKind: Partial<Record<MemoryKind, number>>;
  byScope: Record<string, number>;
  hotTokensEstimate: number;
  dbBytes: number;
  vectorEnabled: boolean;
  ftsEnabled: boolean;
  dim: number;
}

/** Persona 与 Memory 页使用的存储接口；SQLite 与 JSONL 降级实现同一套。 */
export interface MemoryStore {
  readonly backend: 'sqlite' | 'jsonl';
  readonly vectorEnabled: boolean;
  readonly ftsEnabled: boolean;
  readonly dim: number;

  init(): void;
  close(): void;

  get(id: string): MemoryRecord | undefined;
  list(filter?: MemoryFilter): MemoryRecord[];
  search(query: MemoryQuery): MemorySearchHit[];
  hot(limit?: number): MemoryRecord[];

  apply(ops: readonly MemoryOp[], traceId?: string): MemoryApplyResult;
  recordAccess(ids: readonly string[], used?: boolean): void;

  stats(): MemoryStatsSummary;
  exportJsonl(path: string): number;
  backup(path: string): void;
  /** 操作者显式忘记；soft 先标 deleted，hard 再物理删除。 */
  forget(id: string, mode: 'soft' | 'hard'): boolean;

  /** 向量索引；不可用时返回 false，调用方降级到词法。 */
  upsertVector(recordId: string, vector: readonly number[], model: string): boolean;
  knn(vector: readonly number[], k: number): Array<{ recordId: string; score: number }>;
  missingEmbedding(limit?: number): MemoryRecord[];

  /** mood / relationship / attention 等小型状态；由 StateStore 序列化后放这里。 */
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
}
