/**
 * 记忆后台 worker。
 *
 * 钩子只入队、不 await；worker 串行执行：
 *   包 → 直连 core.llm 提取（只提议）→ writeCandidate（保存决策）→ SQLite 事务 → 短回执。
 * 直连不创建 fork/session；工具表只有 memory_propose，不能调 World 工具，不能直接发消息。
 */
import { randomUUID } from 'node:crypto';
import type { Logger, ModelSpec, ToolDef } from 'cortico/core/types.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { MemoryKind, MemoryOp, MemoryScope, MemorySensitivity, MemoryStore } from './types.ts';
import type { DecisionPlane } from '../decision/fallback.ts';
import type { EmbeddingService } from './vectors.ts';
import { writeCandidate, summaryOf } from './write.ts';
import { runDirectWorker } from './runtime.ts';

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
  /** 失败重试次数；只对非显式候选包生效。 */
  attempts?: number;
}

export interface MemoryWorkerOptions {
  /** Core 的模型客户端；直接请求，不创建 fork/session。 */
  llm: () => ResponseClient | null;
  /** 当前端点模型；缺失时跳过提取并写 trace。 */
  spec: () => ModelSpec | null;
  log: Logger;
  store: MemoryStore;
  decision: DecisionPlane | null;
  embedding: EmbeddingService | null;
  queueLimit: number;
  timeoutMs: number;
  warmLimit: number;
  /** bot 自己的名字/自称；区分核心身份与关于他人的事实。 */
  selfNames?: readonly string[];
  logger?: { warn: (msg: string, data?: unknown) => void; info: (msg: string, data?: unknown) => void };
  onTrace?: (event: { task: string; detail: string }) => void;
}

const KINDS: readonly MemoryKind[] = ['identity', 'relationship', 'preference', 'semantic', 'episodic', 'procedural', 'commitment', 'affective', 'goal'];
const SCOPES: readonly MemoryScope['type'][] = ['global', 'person', 'group', 'thread'];
const SENSITIVITY: readonly MemorySensitivity[] = ['normal', 'private', 'secret'];

const MAX_ATTEMPTS = 3;
const DUPLICATE_WINDOW_MS = 10 * 60_000;

export class MemoryWorker {
  private readonly queue: MemoryPacket[] = [];
  private readonly recentKeys = new Map<string, number>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private stopped = false;

  constructor(private readonly opts: MemoryWorkerOptions) {}

  get pending(): number { return this.queue.length; }
  get busy(): boolean { return this.running; }

  /** 配置热改后替换决策/embedding 客户端；已在处理的包继续用旧引用完成。 */
  setClients(decision: DecisionPlane | null, embedding: EmbeddingService | null): void {
    (this.opts as { decision: DecisionPlane | null }).decision = decision;
    (this.opts as { embedding: EmbeddingService | null }).embedding = embedding;
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private writeOptions() {
    return {
      store: this.opts.store,
      decision: this.opts.decision,
      embedding: this.opts.embedding,
      warmLimit: this.opts.warmLimit,
      selfNames: this.opts.selfNames,
    };
  }

  enqueue(packet: MemoryPacket): void {
    if (this.stopped) return;
    const key = packetKey(packet);
    if (key) {
      const now = Date.now();
      const last = this.recentKeys.get(key);
      if (last !== undefined && now - last < DUPLICATE_WINDOW_MS) {
        this.opts.onTrace?.({ task: 'memory.worker', detail: `duplicate packet ${packet.id}` });
        return;
      }
      this.recentKeys.set(key, now);
      if (this.recentKeys.size > 256) {
        for (const [oldKey, at] of this.recentKeys) {
          if (now - at >= DUPLICATE_WINDOW_MS || this.recentKeys.size > 256) this.recentKeys.delete(oldKey);
          if (this.recentKeys.size <= 200) break;
        }
      }
    }
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
          const attempts = (packet.attempts ?? 0) + 1;
          const error = (err as Error)?.message ?? String(err);
          if (attempts <= MAX_ATTEMPTS && !this.stopped) {
            this.opts.logger?.warn(`记忆包处理失败，重试 ${attempts}/${MAX_ATTEMPTS} ${packet.id}`, { error });
            const timer = setTimeout(() => {
              this.retryTimers.delete(timer);
              if (this.stopped) return;
              this.queue.push({ ...packet, attempts });
              void this.drain();
            }, 500 * attempts);
            timer.unref?.();
            this.retryTimers.add(timer);
          } else {
            this.opts.logger?.warn(`记忆包处理失败，已丢弃 ${packet.id}`, { error });
            this.opts.onTrace?.({ task: 'memory.worker', detail: `failed ${packet.id}: ${error}` });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(packet: MemoryPacket): Promise<void> {
    if (this.stopped) return;
    if (packet.candidate) {
      const result = await writeCandidate(packet.candidate, this.writeOptions());
      this.report(packet, summaryOf(result.applied));
      return;
    }
    if (packet.events.length === 0 && !packet.assistant) return;
    const llm = this.opts.llm();
    const spec = this.opts.spec();
    if (!llm || !spec) {
      this.opts.onTrace?.({ task: 'memory.worker', detail: `no model for ${packet.id}` });
      return;
    }

    const staged: MemoryOp[] = [];
    const propose = this.proposeTool(staged, packet);
    const messages = buildMessages(packet);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('memory extraction timeout')), Math.max(1000, this.opts.timeoutMs));
    timer.unref?.();
    let text = '';
    try {
      // 直连 core.llm：不登记 session，控制台不会多出 memory-N 窗口。
      const result = await runDirectWorker({
        llm,
        spec,
        messages,
        tools: [propose],
        log: this.opts.log,
        role: 'memory',
        maxRounds: 2,
        signal: controller.signal,
        stopWhen: () => staged.length > 0,
      });
      text = result.text;
    } finally {
      clearTimeout(timer);
    }

    // 模型没走工具时，尝试从正文里读结构化 JSON；仍然要经过同一套校验。
    if (staged.length === 0 && text.trim()) {
      staged.push(...parseProposalText(text, packet));
    }
    if (staged.length === 0) {
      this.opts.onTrace?.({ task: 'memory.worker', detail: `no proposal ${packet.id}` });
      return;
    }

    let created = 0;
    let updated = 0;
    for (const op of staged) {
      if (op.candidate && op.op !== 'skip' && op.op !== 'defer') {
        const result = await writeCandidate(op.candidate, this.writeOptions());
        created += result.applied.created.length;
        updated += result.applied.updated.length + result.applied.merged.length;
      } else {
        // skip/defer 只留审计；defer 的候选下次再整理，不在本轮落库。
        this.opts.store.apply([op]);
      }
    }
    if (created + updated > 0) this.report(packet, `记忆已整理：新增 ${created} 条，更新 ${updated} 条。`);
    else this.opts.onTrace?.({ task: 'memory.worker', detail: `no durable change ${packet.id}` });
  }

  /**
   * 记忆写入不向主会话回注任何文本。
   *
   * Core 会把内部事件渲染成 user 消息；一条“记忆已整理”会唤醒主模型，模型可能把它当成
   * 用户发言而多回一句，也会污染历史。显式“记住”的回复由主模型在当回合完成；
   * 自主写入只留 trace 与 Memory 页，保持真正静默。
   */
  private report(packet: MemoryPacket, summary: string): void {
    if (!summary) return;
    this.opts.onTrace?.({ task: 'memory.worker', detail: `${packet.id}: ${summary}` });
  }

  private proposeTool(staged: MemoryOp[], packet: MemoryPacket): ToolDef {
    return {
      name: 'memory_propose',
      description: 'Submit structured memory operations extracted from this batch. Only durable, evidence-backed items. identity is only this bot\'s own core self-definition; facts about a user or other people are semantic/relationship with subject set. Do not submit small talk, guesses, secrets, or third-party sensitive data.',
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

/** 同一批事件 + 同一段助手输出只提取一次；handoff 与批末重复入队时省掉一次 fork。 */
function packetKey(packet: MemoryPacket): string {
  if (packet.candidate) return '';
  const events = packet.events
    .map((e) => `${e.cursor ?? ''}|${e.ts}|${e.source}|${e.text.slice(0, 120)}`)
    .join(';');
  const assistant = (packet.assistant ?? '').slice(0, 200);
  return events || assistant ? `${events}::${assistant}` : '';
}

/** 提取提示词的正文预算；超出时保留最近的事件，避免 fork 请求撞上下文上限。 */
const EXTRACT_EVENT_BUDGET = 12_000;

function recentEventLines(packet: MemoryPacket): string {
  const lines: string[] = [];
  let used = 0;
  for (const e of packet.events.slice(-40).reverse()) {
    const line = `[${e.ts}] ${e.source}/${e.type}: ${e.text}`;
    if (used + line.length > EXTRACT_EVENT_BUDGET) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n');
}

function buildMessages(packet: MemoryPacket): ContextRecord[] {
  const eventLines = recentEventLines(packet);
  const text = [
    '你是记忆提取器。只输出结构化提案，不写正文。',
    '规则：只提取耐久的偏好、关系变化、承诺、重要事件、纠正、长期目标、重复模式。',
    '不保存寒暄、一次性情绪、无证据猜测、第三方敏感信息、密钥、完整聊天记录。',
    'kind：identity 只用于你自己的核心身份（你的名字、自称、价值观、边界、对自己的叙事）。'
      + '关于用户或其他人的姓名、资料、偏好用 semantic，关系变化用 relationship，并在 subject 写那个人；'
      + '不要把“用户叫什么”写成 identity。',
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
  let sensitivity = SENSITIVITY.includes(c.sensitivity as MemorySensitivity) ? c.sensitivity as MemorySensitivity : 'normal';
  // 群聊里写进 person scope 的内容默认按 private 处理；不能因为模型忘了标就落成 public。
  if (sensitivity === 'normal' && scope.type === 'person' && packet.scope?.type === 'group') {
    sensitivity = 'private';
  }
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

function parseProposalText(text: string, packet: MemoryPacket): MemoryOp[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown[] };
    // 沿用原包的 scope / source / explicit；否则群聊私事会丢掉 private 降级。
    return (parsed.ops ?? []).map((raw) => normalizeOp(raw, packet)).filter((x): x is MemoryOp => !!x);
  } catch {
    return [];
  }
}

