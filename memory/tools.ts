/**
 * 主 session 的记忆工具。工具只操作 Memory，不操作 World。
 * memory_propose / memory_consolidate 不在这里：它们只出现在后台 fork 的工具表里。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import type { MemoryCandidate, MemoryKind, MemoryScope, MemorySensitivity, MemoryStore } from './types.ts';
import { formatMemoryCards } from './retrieve.ts';
import { memoryCard } from './sqlite.ts';

export interface MemoryToolOptions {
  store: MemoryStore;
  /** 交给 MemoryWorker 的保存流水线；不直接写库。 */
  onNote?: (candidate: MemoryCandidate) => void;
  /** 操作者确认后才允许模型物理删除。 */
  allowForget?: boolean;
  /** 当前对话 scope；memory_search / memory_note 未显式指定时用它。 */
  currentScope?: () => MemoryScope;
  /** 本批用户是否明确要求记住；用于把 memory_note 标成 explicit。 */
  explicitRequest?: () => boolean;
}

const KINDS: readonly MemoryKind[] = ['identity', 'relationship', 'preference', 'semantic', 'episodic', 'procedural', 'commitment', 'affective', 'goal'];
const SCOPES: readonly MemoryScope['type'][] = ['global', 'person', 'group', 'thread'];
const SENSITIVITY: readonly MemorySensitivity[] = ['normal', 'private', 'secret'];

function scopeFrom(args: Record<string, unknown>, fallback?: () => MemoryScope): MemoryScope {
  if (args.scope_type === undefined && args.scope_id === undefined && fallback) return fallback();
  const type = String(args.scope_type ?? 'global') as MemoryScope['type'];
  const id = typeof args.scope_id === 'string' && args.scope_id.trim() ? args.scope_id.trim() : undefined;
  return { type: SCOPES.includes(type) ? type : 'global', ...(id ? { id } : {}) };
}

function asKind(value: unknown): MemoryKind {
  return KINDS.includes(value as MemoryKind) ? value as MemoryKind : 'semantic';
}

function asSensitivity(value: unknown): MemorySensitivity {
  return SENSITIVITY.includes(value as MemorySensitivity) ? value as MemorySensitivity : 'normal';
}

export function memoryToolDecls(): Array<Omit<ToolDef, 'handler'>> {
  return [
    {
      name: 'memory_search',
      description: 'Search long-term memory. Returns compact cards, not full records. Use when you need a detail the injected cards do not cover.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          scope_type: { type: 'string', enum: [...SCOPES] },
          scope_id: { type: 'string' },
          kind: { type: 'string', enum: [...KINDS] },
          include_cold: { type: 'boolean', description: 'Also search archived/cold memories.' },
          limit: { type: 'integer', minimum: 1, maximum: 30 },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_read',
      description: 'Read one memory record with its evidence and timestamps.',
      tags: ['read'],
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Memory id, e.g. mem_...' } },
        required: ['id'],
      },
    },
    {
      name: 'memory_note',
      description: 'Propose a durable memory. It goes through the save decision; it is not written immediately. identity means your own core self-definition only; facts about the user or other people are semantic/relationship with subject set.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS] },
          title: { type: 'string', description: 'One-line summary.' },
          content: { type: 'string', description: 'Normalized short fact/preference/episode.' },
          scope_type: { type: 'string', enum: [...SCOPES] },
          scope_id: { type: 'string' },
          subject: { type: 'string' },
          sensitivity: { type: 'string', enum: [...SENSITIVITY] },
          explicit: { type: 'boolean', description: 'True only when the user explicitly asked to remember this.' },
        },
        required: ['kind', 'title', 'content'],
      },
    },
    {
      name: 'memory_pin',
      description: 'Raise or lower a memory tier. Does not change facts.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tier: { type: 'string', enum: ['hot', 'warm', 'cold'] },
        },
        required: ['id', 'tier'],
      },
    },
    {
      name: 'memory_forget',
      description: 'Request forgetting a memory. Without confirm=true it only marks the request; the operator confirms in the Memory page.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          hard: { type: 'boolean', description: 'Physically delete after confirmation.' },
          confirm: { type: 'boolean', description: 'Only set when the operator explicitly confirmed.' },
        },
        required: ['id'],
      },
    },
  ];
}

export function memoryTools(opts: MemoryToolOptions): ToolDef[] {
  return memoryToolDecls().map((decl) => ({
    ...decl,
    handler: async (args) => handle(decl.name, args, opts),
  }));
}

async function handle(name: string, args: Record<string, unknown>, opts: MemoryToolOptions): Promise<string> {
  switch (name) {
    case 'memory_search': {
      const hits = opts.store.search({
        text: String(args.query ?? ''),
        scope: scopeFrom(args, opts.currentScope),
        kinds: args.kind ? [asKind(args.kind)] : undefined,
        includeCold: args.include_cold === true,
        limit: Math.max(1, Math.min(30, Number(args.limit ?? 8))),
      });
      if (hits.length === 0) return '没有匹配的记忆。';
      return formatMemoryCards(hits.map((h) => memoryCard(h.record)));
    }
    case 'memory_read': {
      const record = opts.store.get(String(args.id ?? ''));
      if (!record || record.status === 'deleted') return '没有这条记忆。';
      return JSON.stringify({
        id: record.id,
        kind: record.kind,
        tier: record.tier,
        scope: record.scope,
        subject: record.subject,
        title: record.title,
        content: record.content,
        confidence: record.confidence,
        salience: record.salience,
        sensitivity: record.sensitivity,
        valid: record.valid,
        evidence: record.evidence,
        links: record.links,
        status: record.status,
        stats: record.stats,
      }, null, 2);
    }
    case 'memory_note': {
      const title = String(args.title ?? '').trim();
      const content = String(args.content ?? '').trim();
      if (!title || !content) return 'title 与 content 不能为空。';
      const candidate: MemoryCandidate = {
        kind: asKind(args.kind),
        scope: scopeFrom(args, opts.currentScope),
        subject: typeof args.subject === 'string' ? args.subject : undefined,
        title: title.slice(0, 200),
        content: content.slice(0, 2000),
        evidence: [{ at: new Date().toISOString(), quote: content.slice(0, 200), source: 'memory_note' }],
        sensitivity: asSensitivity(args.sensitivity),
        explicit: args.explicit === true || opts.explicitRequest?.() === true,
      };
      if (!opts.onNote) return '记忆队列不可用，本条未保存。';
      opts.onNote(candidate);
      return '已交给记忆决策；不保证一定保存。';
    }
    case 'memory_pin': {
      const id = String(args.id ?? '');
      const tier = String(args.tier ?? 'warm');
      if (tier !== 'hot' && tier !== 'warm' && tier !== 'cold') return 'tier 只能是 hot/warm/cold。';
      if (!opts.store.get(id)) return '没有这条记忆。';
      opts.store.apply([{ op: tier === 'cold' ? 'demote' : 'promote', targetIds: [id], tier }]);
      return `已把 ${id} 调整为 ${tier}。`;
    }
    case 'memory_forget': {
      const id = String(args.id ?? '');
      const record = opts.store.get(id);
      if (!record) return '没有这条记忆。';
      if (args.confirm !== true) return '已记录忘记请求；需要操作者在 Memory 页确认后才会删除。';
      if (!opts.allowForget) return '当前配置不允许模型直接删除；请在 Memory 页操作。';
      const hard = args.hard === true && record.kind !== 'identity';
      const ok = opts.store.forget(id, hard ? 'hard' : 'soft');
      return ok ? `已${hard ? '物理删除' : '标记删除'} ${id}。` : '删除失败。';
    }
    default:
      return `未知记忆工具 ${name}`;
  }
}
