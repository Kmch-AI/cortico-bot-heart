/**
 * 记忆后台 worker。
 *
 * 钩子只入队、不 await；worker 串行执行：
 *   包 → fork 提取（只提议）→ writeCandidate（保存决策）→ SQLite 事务 → 短回执。
 * fork 的工具表只有 memory_propose，不能调 World 工具，不能直接发消息。
 */
import { randomUUID } from 'node:crypto';
import type { CoreApi, ToolDef } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { MemoryKind, MemoryOp, MemoryScope, MemorySensitivity, MemoryStore } from './types.ts';
import type { DecisionPlane } from '../decision/fallback.ts';
import type { EmbeddingService } from './vectors.ts';
import { writeCandidate, summaryOf } from './write.ts';

export interface MemoryPacket {
  id: string;
  at: string;
  events: Array<{ cursor?: number; type: string; source: string; text: string; ts: string; senderKey?: string }>;
  assistant?: string;
  source?: string;
  scope?: MemoryScope;
  explicit?: boolean;
  candidate?: import('./types.ts').MemoryCandidate;
  priority: number;
}

export interface MemoryWorkerOptions {
  core: () => CoreApi | null;
  store: MemoryStore;
  decision: DecisionPlane | null;
  embedding: EmbeddingService | null;
  queueLimit: number;
  timeoutMs: number;
  warmLimit: number;
  logger?: { warn: (msg: string, data?: unknown) => void; info: (msg: string, data?: unknown) => void };
  onTrace?: (event: { task: string; detail: string }) => void;
}

const KINDS: readonly MemoryKind[] = ['identity', 'relationship', 'preference', 'semantic', 'episodic', 'procedural', 'commitment', 'affective', 'goal'];
const SCOPES: readonly MemoryScope['type'][] = ['global', 'person', 'group', 'thread'];
const SENSITIVITY: readonly MemorySensitivity[] = ['normal', 'private', 'secret'];

export class MemoryWorker {
  private readonly queue: MemoryPacket[] = [];
  private running = false;
  private stopped = false;

  constructor(private readonly opts: MemoryWorkerOptions) {}

  get pending(): number { return this.queue.length; }
  get busy(): boolean { return this.running; }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  enqueue(packet: MemoryPacket): void {
    if (this.stopped) return;
    if (this.queue.length >= this.opts.queueLimit) {
      let minIndex = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i]!.priority < this.queue[minIndex]!.priority) minIndex = i;
      }
      if (packet.priority <= this.queue[minIndex]!.priority) {
        this.opts.logger?.warn(`记忆队列满，丢弃包 ${packet.id}`);
        return;
      }
      this.queue.splice(minIndex, 1);
    }
    this.queue.push(packet);
    void this.drain();
  }

  enqueueExplicit(candidate: NonNullable<MemoryPacket['candidate']>, scope?: MemoryScope, source?: string): void {
    this.enqueue({
      id: `packet_${randomUUID()}`,
      at: new Date().toISOString(),
      events: [],
      scope: scope ?? candidate.scope,
      source,
      explicit: true,
      candidate,
      priority: 100,
    });
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const packet = this.queue.shift()!;
        try {
          await this.process(packet);
        } catch (err) {
          this.opts.logger?.warn(`记忆包处理失败 ${packet.id}`, { error: (err as Error)?.message ?? String(err) });
          this.opts.onTrace?.({ task: 'memory.worker', detail: `failed ${packet.id}: ${(err as Error)?.message ?? err}` });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(packet: MemoryPacket): Promise<void> {
    if (this.stopped) return;
    if (packet.candidate) {
      const result = await writeCandidate(packet.candidate, {
        store: this.opts.store,
        decision: this.opts.decision,
        embedding: this.opts.embedding,
        warmLimit: this.opts.warmLimit,
      });
      this.report(packet, summaryOf(result.applied));
      return;
    }
    const core = this.opts.core();
    if (!core) return;
    if (packet.events.length === 0 && !packet.assistant) return;

    const staged: MemoryOp[] = [];
    const propose = this.proposeTool(staged, packet);
    const messages = buildMessages(packet);
    let text = '';
    const fork = core.spawnFork({
      id: 'memory',
      messages,
      tools: [propose],
      stopWhen: () => staged.length > 0,
      wrapUpHint: '收线：没整理完的部分丢弃，不要编造；只提交有证据的候选。',
      capNote: '记忆提取达到轮数上限，未提交的部分丢弃。',
    });
    text = await withTimeout(fork, this.opts.timeoutMs, '');

    // 模型没走工具时，尝试从正文里读结构化 JSON；仍然要经过同一套校验。
    if (staged.length === 0 && text.trim()) {
      staged.push(...parseProposalText(text));
    }
    if (staged.length === 0) {
      this.opts.onTrace?.({ task: 'memory.worker', detail: `no proposal ${packet.id}` });
      return;
    }

    let created = 0;
    let updated = 0;
    for (const op of staged) {
      if (op.candidate) {
        const result = await writeCandidate(op.candidate, {
          store: this.opts.store,
          decision: this.opts.decision,
          embedding: this.opts.embedding,
          warmLimit: this.opts.warmLimit,
        });
        created += result.applied.created.length;
        updated += result.applied.updated.length + result.applied.merged.length;
      } else if (op.op === 'skip' || op.op === 'defer') {
        this.opts.store.apply([op]);
      }
    }
    if (created + updated > 0) this.report(packet, `记忆已整理：新增 ${created} 条，更新 ${updated} 条。`);
    else this.opts.onTrace?.({ task: 'memory.worker', detail: `no durable change ${packet.id}` });
  }

  private report(packet: MemoryPacket, summary: string): void {
    if (!summary) return;
    const core = this.opts.core();
    if (!core) return;
    try {
      core.injectDeferred('memory.result', () => summary);
    } catch (err) {
      this.opts.logger?.warn('记忆回执注入失败', { error: (err as Error)?.message ?? String(err) });
    }
    this.opts.onTrace?.({ task: 'memory.worker', detail: `${packet.id}: ${summary}` });
  }

  private proposeTool(staged: MemoryOp[], packet: MemoryPacket): ToolDef {
    return {
      name: 'memory_propose',
      description: 'Submit structured memory operations extracted from this batch. Only durable, evidence-backed items. Do not submit small talk, guesses, secrets, or third-party sensitive data.',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['create', 'update', 'merge', 'skip', 'defer'] },
                candidate: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: [...KINDS] },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    subject: { type: 'string' },
                    scope_type: { type: 'string', enum: [...SCOPES] },
                    scope_id: { type: 'string' },
                    sensitivity: { type: 'string', enum: [...SENSITIVITY] },
                    explicit: { type: 'boolean' },
                    evidence: { type: 'array', items: { type: 'object', properties: { eventId: { type: 'string' }, quote: { type: 'string' } } } },
                  },
                  required: ['kind', 'title', 'content'],
                },
                targetIds: { type: 'array', items: { type: 'string' } },
                reason: { type: 'string' },
              },
              required: ['op'],
            },
          },
        },
        required: ['ops'],
      },
      handler: async (args) => {
        const ops = Array.isArray(args.ops) ? args.ops : [];
        for (const raw of ops) {
          const normalized = normalizeOp(raw, packet);
          if (normalized) staged.push(normalized);
        }
        return staged.length > 0 ? `[proposed ${staged.length}]` : '[no valid proposal]';
      },
    };
  }
}

function buildMessages(packet: MemoryPacket): ContextRecord[] {
  const eventLines = packet.events.map((e) => `[${e.ts}] ${e.source}/${e.type}: ${e.text}`).join('\n');
  const text = [
    '你是记忆提取器。只输出结构化提案，不写正文。',
    '规则：只提取耐久的偏好、关系变化、承诺、重要事件、纠正、身份相关、长期目标、重复模式。',
    '不保存寒暄、一次性情绪、无证据猜测、第三方敏感信息、密钥、完整聊天记录。',
    '每个候选必须有证据（event id 或短引用）。没有证据只能 defer。',
    '用户明确说“记住”时，candidate.explicit=true；即使你建议 skip 也要提交，让上层留审计。',
    '',
    '本批事件：',
    eventLines || '(无)',
    '',
    '助手输出：',
    (packet.assistant?.trim() || '(无)').slice(0, 4000),
    '',
    '调用 memory_propose 提交 ops。',
  ].join('\n');
  return [{
    version: 2,
    item: {
      type: 'message',
      id: `msg_${randomUUID()}`,
      status: 'completed',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
    context: {},
  }];
}

function normalizeOp(raw: unknown, packet: MemoryPacket): MemoryOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const opRaw = String(r.op ?? '');
  const allowed = ['create', 'update', 'merge', 'skip', 'defer'] as const;
  if (!(allowed as readonly string[]).includes(opRaw)) return null;
  const op = opRaw as MemoryOp['op'];
  const c = r.candidate;
  if (!c || typeof c !== 'object') {
    if (op === 'skip' || op === 'defer') return { op, reason: String(r.reason ?? '') };
    return null;
  }
  const candidate = normalizeCandidate(c as Record<string, unknown>, packet);
  if (!candidate) return null;
  return {
    op,
    candidate,
    targetIds: Array.isArray(r.targetIds) ? r.targetIds.map(String).filter(Boolean).slice(0, 8) : undefined,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 400) : undefined,
  };
}

function normalizeCandidate(c: Record<string, unknown>, packet: MemoryPacket): import('./types.ts').MemoryCandidate | null {
  const title = String(c.title ?? '').trim();
  const content = String(c.content ?? '').trim();
  if (!title || !content) return null;
  const kind = KINDS.includes(c.kind as MemoryKind) ? c.kind as MemoryKind : 'semantic';
  const scopeRaw = c.scope && typeof c.scope === 'object' ? c.scope as Record<string, unknown> : c;
  const scopeType = String(scopeRaw.scope_type ?? scopeRaw.type ?? packet.scope?.type ?? 'global');
  const scopeId = String(scopeRaw.scope_id ?? scopeRaw.id ?? packet.scope?.id ?? '').trim();
  const scope: MemoryScope = SCOPES.includes(scopeType as MemoryScope['type'])
    ? { type: scopeType as MemoryScope['type'], ...(scopeId ? { id: scopeId } : {}) }
    : { type: 'global' };
  const sensitivity = SENSITIVITY.includes(c.sensitivity as MemorySensitivity) ? c.sensitivity as MemorySensitivity : 'normal';
  const evidence = Array.isArray(c.evidence) && c.evidence.length > 0
    ? c.evidence.slice(0, 8).map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      return {
        eventId: typeof x.eventId === 'string' ? x.eventId : undefined,
        quote: typeof x.quote === 'string' ? x.quote.slice(0, 300) : undefined,
        at: packet.at,
        source: packet.source,
      };
    })
    : [{ at: packet.at, quote: packet.events[0]?.text.slice(0, 200), eventId: packet.events[0]?.cursor != null ? String(packet.events[0].cursor) : undefined, source: packet.source }];
  return {
    kind,
    scope,
    subject: typeof c.subject === 'string' ? c.subject.slice(0, 120) : undefined,
    title: title.slice(0, 200),
    content: content.slice(0, 3000),
    evidence,
    sensitivity,
    explicit: c.explicit === true || packet.explicit === true,
  };
}

function parseProposalText(text: string): MemoryOp[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown[] };
    const packet: MemoryPacket = { id: 'text', at: new Date().toISOString(), events: [], priority: 0 };
    return (parsed.ops ?? []).map((raw) => normalizeOp(raw, packet)).filter((x): x is MemoryOp => !!x);
  } catch {
    return [];
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(1000, timeoutMs));
        timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
