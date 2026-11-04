/**
 * Heart Persona：前缀、主 session、回合决策、状态头、记忆 worker 的接线处。
 *
 * 边界：
 * - 不直接执行 World 工具；语音/QQ 由主模型按 DeliveryPlan 调用。
 * - 钩子不 await 记忆任务；只入队，worker 在后台串行处理。
 * - stock Core 上沉默是语义沉默：注入一句“不要回应”，主模型仍会跑一次。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BlobStore,
  CoreApi,
  OutputTap,
  Persona,
  PersonaWebUiDecl,
  PrefixSegment,
  RoundCaps,
  SessionDecl,
  SessionOpeningReason,
  SystemPrefixContext,
  ToolDef,
  World,
} from 'cortico/core/types.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { readTextFile } from 'cortico/core/util.ts';
import type { ContextRecord, Item } from 'cortico/protocol/open-responses/context.ts';
import { itemText } from 'cortico/protocol/open-responses/context.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';
import type { HeartConfig } from '../config.ts';
import { createMemoryStore } from '../memory/store.ts';
import type { MemoryCandidate, MemoryCard, MemoryRecord, MemoryScope, MemoryStore } from '../memory/types.ts';
import { MemoryWorker, type MemoryPacket } from '../memory/worker.ts';
import { memoryTools, memoryToolDecls } from '../memory/tools.ts';
import { retrieveMemories } from '../memory/retrieve.ts';
import { consolidate } from '../memory/consolidate.ts';
import { EmbeddingService, HttpEmbeddingService, HttpRerankService, RerankService } from '../memory/vectors.ts';
import { DecisionPlane, type DecisionTrace } from '../decision/fallback.ts';
import { SystemOneClient } from '../decision/systemone.ts';
import { probeService } from '../decision/probe.ts';
import { MoodEngine } from '../state/mood.ts';
import { RelationshipEngine } from '../state/relationship.ts';
import { AttentionEngine } from '../state/attention.ts';
import { buildStateCard, identityView } from '../state/stateCard.ts';
import { ChannelRouter, formatDeliveryPlan, routeScope, type DeliveryPlan } from '../output/route.ts';
import { emotionalIntensity, gateVoice, isExplicitVoiceRequest } from '../output/voice.ts';
import { buildCandidateBrief, fallbackChoice, parseCandidates, shouldArbitrate } from '../output/arbiter.ts';
import { heuristicTurnPlan, renderTurnPlan, type TurnPlan, type TurnPlanInput } from '../output/turnPlan.ts';
import { FileBlobStore } from './blobs.ts';
import { supportsDeliveryDrop } from './coreCompat.ts';

const MAIN = 'main';
const MEMORY = 'memory';
const ARBITER = 'arbiter';

export interface HeartPersonaOptions {
  memoryDir: string;
  packageDir: string;
  worlds: readonly World[];
  config: () => HeartConfig;
  secret: (name: string) => string;
  logger?: { warn: (msg: string, data?: unknown) => void; info: (msg: string, data?: unknown) => void };
}

interface PendingEvent {
  cursor?: number;
  type: string;
  source: string;
  text: string;
  ts: string;
  senderKey?: string;
}

const END_TURN_DECL: Omit<ToolDef, 'handler'> = {
  name: 'end_turn',
  description:
    'End this turn: nothing more you want to say or do right now. '
    + 'New events will wake you again. This is the normal way to finish a turn.',
  tags: ['flow'],
  barrierAfter: true,
  endsTurn: true,
  parameters: { type: 'object', properties: {}, required: [] },
};

export class HeartPersona implements Persona {
  readonly memoryDir: string;
  readonly blobs: BlobStore;
  store!: MemoryStore;
  mood!: MoodEngine;
  relationship!: RelationshipEngine;
  attention!: AttentionEngine;
  worker!: MemoryWorker;
  /** Core 不读它的内容；Memory 页通过 webUi().memory 声明。attach 后换成 Store。 */
  memory: object = {};

  private core: CoreApi | null = null;
  private router: ChannelRouter;
  private decision!: DecisionPlane;
  private embedding: EmbeddingService | null = null;
  private rerank: RerankService | null = null;
  private tap: OutputTap;

  private pendingEvents: PendingEvent[] = [];
  private assistantBuffer = '';
  private calledTools = new Set<string>();
  private lastPlan: TurnPlan | null = null;
  private lastDelivery: DeliveryPlan | null = null;
  private lastScope: MemoryScope = { type: 'global' };
  private lastMemoryCards: MemoryCard[] = [];
  private lastTrace: DecisionTrace | null = null;
  private turns = 0;
  private lastVoiceTurn: number | null = null;
  private lastConsolidation = 0;
  private shutdownDone = false;
  private clientKey = '';

  constructor(private readonly opts: HeartPersonaOptions) {
    this.memoryDir = opts.memoryDir;
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(join(this.memoryDir, 'decisions'), { recursive: true });
    mkdirSync(join(this.memoryDir, 'export'), { recursive: true });
    this.blobs = new FileBlobStore(this.memoryDir);
    this.router = new ChannelRouter(opts.worlds);
    this.tap = {
      onEvent: (event: StreamEvent) => {
        if (event.type === 'response.output_text.delta') this.assistantBuffer += event.delta;
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          this.calledTools.add(event.item.name);
        }
      },
      onAbort: () => { this.assistantBuffer = ''; },
    };
  }

  attach(core: CoreApi): void {
    this.core = core;
    this.initStores();
    core.timers.onDue((entry) => {
      if (entry.payload?.kind === 'consolidate') {
        this.runConsolidation();
        this.scheduleConsolidation();
      }
    });
    this.scheduleConsolidation();
    core.log.info('heart attached', {
      memoryDir: this.memoryDir,
      backend: this.store.backend,
      vector: this.store.vectorEnabled,
      deliveryDrop: supportsDeliveryDrop(core),
    });
  }

  /** BotParts.onStop 调用；先停 worker，再 checkpoint/关闭 SQLite。 */
  shutdown(): void {
    if (this.shutdownDone || !this.store) return;
    this.shutdownDone = true;
    this.worker.stop();
    this.store.close();
  }

  /** 存储与后台 worker 延迟到 attach 才打开：dry-mount 只构造 Persona，不应占用 Memory 目录。 */
  private initStores(): void {
    if (this.store) return;
    const cfg = this.opts.config();
    this.store = createMemoryStore({
      dir: this.memoryDir,
      backend: cfg.memory.backend,
      dim: cfg.vectors.dim,
      logger: this.opts.logger,
    });
    this.mood = new MoodEngine({
      store: this.store,
      baseline: cfg.mood.baseline,
      inertia: cfg.mood.inertia,
      halfLifeMinutes: cfg.mood.halfLifeMinutes,
    });
    this.relationship = new RelationshipEngine(this.store);
    this.attention = new AttentionEngine({ store: this.store });
    this.embedding = this.makeEmbedding();
    this.rerank = this.makeRerank();
    this.decision = this.makeDecision();
    this.clientKey = this.currentClientKey();
    this.worker = new MemoryWorker({
      core: () => this.core,
      store: this.store,
      decision: this.decision,
      embedding: cfg.memory.autoEmbedding ? this.embedding : null,
      queueLimit: cfg.worker.queueLimit,
      timeoutMs: cfg.worker.timeoutMs,
      warmLimit: cfg.memory.warmLimit,
      logger: this.opts.logger,
      onTrace: (event) => this.trace({ task: event.task, at: new Date().toISOString(), mode: 'systemone', latencyMs: 0, summary: event.detail }),
    });
    this.memory = this.store;
  }

  // -------------------------------------------------------------------------
  // 前缀与 session
  // -------------------------------------------------------------------------

  async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
    this.initStores();
    const cfg = this.opts.config();
    const identity = this.identityText();
    const envPrompts = ctx.worlds
      .filter((w) => w.envPrompt.trim())
      .map((w) => `## ${w.id}\n${w.envPrompt.trim()}`)
      .join('\n\n');
    const read = (name: string): string => {
      const path = join(this.opts.packageDir, 'persona', name);
      return existsSync(path) ? readTextFile(path) : '';
    };
    const vars = {
      'persona.identity': identity,
      'persona.displayName': cfg.identity.displayName,
      'worlds.envPrompts': envPrompts,
    };
    return [
      { title: 'PREFIX', text: renderTemplate(read('PREFIX.md'), vars) },
      { title: 'BEHAVIOR', text: renderTemplate(read('BEHAVIOR.md'), vars) },
      { title: 'MEMORY_PROTOCOL', text: renderTemplate(read('MEMORY_PROTOCOL.md'), vars) },
    ].filter((s) => s.text.trim());
  }

  promptVarValues(): Record<string, string> {
    return {
      'persona.identity': this.identityText(),
      'persona.displayName': this.opts.config().identity.displayName,
      'worlds.envPrompts': '',
    };
  }

  onOpening(ctx: { reason: SessionOpeningReason }): void {
    this.initStores();
    const mood = this.mood.current();
    const threads = this.attention.current().threads.filter((t) => t.status !== 'closed').slice(0, 2);
    this.core?.injectInternal(
      `[opening ${ctx.reason}] 你醒着。${mood.label}。${threads.length ? `未完成：${threads.map((t) => t.title).join(' | ')}` : '没有未完成线程。'} 按自己的判断行动，或结束本轮。`,
      'opening',
    );
  }

  declareSessions(): SessionDecl[] {
    this.initStores();
    const tap = this.tap;
    return [
      {
        id: MAIN,
        label: MAIN,
        rounds: () => this.rounds(),
        persistent: true,
        receivesEvents: true,
        get outputTap() { return tap; },
        tools: () => [...this.worldTools(), ...this.ownTools()],
      },
      {
        id: MEMORY,
        label: MEMORY,
        rounds: () => ({ soft: 3, hard: 5 }),
        persistent: false,
        receivesEvents: false,
        tools: () => [],
      },
      {
        id: ARBITER,
        label: ARBITER,
        rounds: () => ({ soft: 1, hard: 2 }),
        persistent: false,
        receivesEvents: false,
        tools: () => [],
      },
    ];
  }

  private rounds(): RoundCaps {
    const cfg = this.opts.config();
    return {
      soft: cfg.rounds.soft,
      hard: cfg.rounds.hard,
      softHint: () => '收束这一轮；没有新内容就 end_turn。',
    };
  }

  private worldTools(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const world of this.opts.worlds) {
      try { out.push(...world.tools()); } catch { /* 单个 World 失败不拖垮工具表 */ }
    }
    return out;
  }

  private ownTools(): ToolDef[] {
    return [
      ...memoryTools({
        store: this.store,
        onNote: (candidate) => this.worker.enqueueExplicit(candidate, this.lastScope, this.lastDelivery?.source),
        allowForget: false,
        currentScope: () => this.lastScope,
      }),
      endTurnTool(),
    ];
  }

  ownToolNames(): string[] {
    return [...memoryToolDecls().map((d) => d.name), END_TURN_DECL.name];
  }

  // -------------------------------------------------------------------------
  // 回合
  // -------------------------------------------------------------------------

  async onDelivery(ctx: { events: EventEnvelope[] }): Promise<void> {
    this.initStores();
    this.refreshClients();
    const incoming = ctx.events.filter(isIncoming);
    if (incoming.length === 0) {
      // 内部通知（记忆回执、交接提示）不产生新的 turn plan；避免把上一批的计划当成这一批的。
      this.lastPlan = null;
      this.lastDelivery = null;
      this.lastMemoryCards = [];
      return;
    }
    const cfg = this.opts.config();
    const last = incoming[incoming.length - 1]!;
    const text = incoming.map((e) => e.text).join('\n').slice(0, 4000);

    for (const event of incoming) {
      this.pendingEvents.push({
        cursor: event.cursor,
        type: event.type,
        source: event.source,
        text: event.text.slice(0, 4000),
        ts: event.ts,
        senderKey: event.senderKey,
      });
    }
    if (this.pendingEvents.length > 200) this.pendingEvents.splice(0, this.pendingEvents.length - 200);
    const addressed = isAddressed(incoming, cfg.identity.displayName);
    this.attention.observe({
      text,
      source: last.source,
      sender: last.senderKey,
      at: last.ts,
      addressed,
    });
    const route = this.router.route(incoming);
    const scope = routeScope(route);
    this.lastScope = scope;
    this.relationship.remember(scope);
    const relationship = this.relationship.get(scope);
    const mood = this.mood.current();
    const input: TurnPlanInput = {
      text,
      source: last.source,
      addressed,
      isPrivate: isPrivateConversation(incoming),
      mentioned: isMentioned(incoming, cfg.identity.displayName),
      mood,
      relationship,
      recentAssistantCount: this.recentAssistantCount(),
      voiceAvailable: route.voiceAvailable,
      explicitVoiceRequested: isExplicitVoiceRequest(text, cfg.voice.explicitKeywords),
    };
    const state = {
      events: text,
      recent: this.recentText(),
      mood: {
        valence: mood.valence, arousal: mood.arousal, energy: mood.energy,
        tension: mood.tension, openness: mood.openness, patience: mood.patience,
        playfulness: mood.playfulness, label: mood.label,
      },
      relationship: {
        familiarity: relationship.familiarity, trust: relationship.trust,
        intimacy: relationship.intimacy, tension: relationship.tension, status: relationship.status,
      },
      hot: this.store.hot(6).map((r) => `${r.title}: ${r.content}`),
      delivery: formatDeliveryPlan(route),
      flags: {
        addressed: input.addressed,
        private: input.isPrivate,
        mentioned: input.mentioned,
        voiceAvailable: route.voiceAvailable,
        explicitVoiceRequested: input.explicitVoiceRequested,
      },
    };

    const [decided, appraisal] = await Promise.all([
      this.decision.plan(input, state),
      this.decision.appraise(text, {
        mood: { valence: mood.valence, energy: mood.energy, tension: mood.tension },
        relationship: { familiarity: relationship.familiarity, trust: relationship.trust },
      }),
    ]);
    const plan = decided.plan;
    this.lastTrace = decided.trace;
    this.trace(decided.trace);
    if (appraisal) {
      this.mood.appraise(appraisal, last.cursor != null ? String(last.cursor) : undefined, new Date());
      this.relationship.update(scope, {
        familiarity: Math.max(0, appraisal.relationshipDelta) * 0.01,
        trust: Math.max(0, appraisal.relationshipDelta) * 0.005,
        tension: Math.max(0, -appraisal.relationshipDelta) * 0.015,
      });
    }

    if (plan.action === 'respond' && route.text === 'none') {
      plan.action = 'silence';
      plan.reason += '; text_unsupported';
    }

    const gate = gateVoice({
      plan,
      route,
      cfg: cfg.voice,
      isPrivate: input.isPrivate,
      isGroup: isGroupConversation(incoming),
      explicitRequested: input.explicitVoiceRequested ?? false,
      turnsSinceVoice: this.lastVoiceTurn === null ? null : this.turns - this.lastVoiceTurn,
      emotionalIntensity: emotionalIntensity(plan, mood),
    });
    if (!gate.send) {
      plan.voice = false;
      plan.reason += `; voice: ${gate.reason}`;
    } else {
      this.lastVoiceTurn = this.turns;
    }

    this.lastPlan = plan;
    this.lastDelivery = route;

    if (plan.action === 'respond' && shouldArbitrate(cfg.output.mode, plan) && this.core) {
      const stateCard = buildStateCard({
        mood: this.mood.current(),
        relationship,
        attention: this.attention.current(),
        identity: this.identityText(),
        planText: renderTurnPlan(plan, formatDeliveryPlan(route)),
        tokenBudget: cfg.memory.hotTokenBudget,
      });
      const brief = buildCandidateBrief({
        stateCard,
        planText: renderTurnPlan(plan, formatDeliveryPlan(route)),
        deliveryText: formatDeliveryPlan(route),
        count: cfg.output.candidates,
      });
      try {
        const text = await withTimeout(this.core.spawnFork({
          id: ARBITER,
          messages: [userRecord(brief)],
          tools: [],
          wrapUpHint: '收线：只保留候选正文。',
        }), cfg.output.timeoutMs, '');
        const candidates = parseCandidates(text, cfg.output.candidates);
        if (candidates.length > 1) {
          const chosenId = await this.decision.arbiter(brief, candidates);
          const chosen = candidates.find((c) => c.id === chosenId) ?? fallbackChoice(candidates);
          if (chosen) {
            this.core.injectInternal(`[arbiter] 参考候选（不是必须照抄，最终仍按你自己的判断表达）：
${chosen.text}`, 'arbiter');
          }
        }
      } catch (err) {
        this.trace({ task: 'output_arbiter', at: new Date().toISOString(), mode: 'skipped', latencyMs: 0, error: (err as Error)?.message ?? String(err) });
      }
    }

    if (plan.action === 'respond') {
      const retrieval = await retrieveMemories(
        { events: incoming, recentText: this.recentText(), mood, attention: this.attention.current(), delivery: route, scope },
        {
          store: this.store,
          embedding: this.embedding,
          rerank: this.rerank,
          topK: cfg.retrieval.topK,
          rerankTopN: cfg.retrieval.rerankTopN,
          tokenBudget: cfg.retrieval.tokenBudget,
          mmrLambda: cfg.retrieval.mmrLambda,
          abstainThreshold: cfg.retrieval.abstainThreshold,
        },
      );
      this.lastMemoryCards = retrieval.cards;
      if (retrieval.records.length > 0) this.store.recordAccess(retrieval.records.map((r) => r.id));
      if (retrieval.degraded) this.opts.logger?.warn('记忆检索降级', { trace: retrieval.trace });
    } else {
      this.lastMemoryCards = [];
    }

    if (plan.action === 'silence') {
      this.core?.injectInternal(
        '[attention] 这一批不值得回应。不要输出正文，不要调用发送工具，直接 end_turn。',
        'attention',
      );
    } else if (plan.action === 'defer') {
      this.attention.defer(text, last.source);
      this.core?.injectInternal(
        '[attention] 这一批先不接；已记到未完成线程。不要输出正文，不要调用发送工具，直接 end_turn。',
        'attention',
      );
    }
  }

  onBatchEnd(): void {
    this.initStores();
    this.flushPacket();
    this.turns++;
    this.mood.tick();
    this.attention.tick();
  }

  onTurnEnded(): void {
    if (this.lastPlan?.voice && !this.calledTools.has('voice_speak')) {
      this.trace({
        task: 'voice_miss', at: new Date().toISOString(), mode: 'skipped', latencyMs: 0,
        summary: `plan wanted voice, tools=${[...this.calledTools].join(',') || 'none'}`,
      });
    }
  }

  onIdle(): void {
    this.initStores();
    this.flushPacket();
    this.mood.tick();
    this.attention.tick();
    const cfg = this.opts.config();
    if (cfg.worker.consolidation) {
      const due = Date.now() - this.lastConsolidation >= cfg.consolidation.idleMinutes * 60_000;
      if (due) this.runConsolidation();
    }
  }

  onStallsRecovered(): string | null {
    return null;
  }

  onWorldLifecycle(event: { kind: string; id: string; label: string; reason?: string }): void {
    this.opts.logger?.info(`world ${event.kind}: ${event.id}`, event.reason ? { reason: event.reason } : undefined);
  }

  async onHandoff(snapshot: ContextRecord[]): Promise<{ tail: ContextRecord[] | null }> {
    this.initStores();
    this.flushPacket();
    const recent = snapshot.filter((r) => r.item.type === 'message').slice(-12);
    const assistant = recent.filter((r) => r.item.type === 'message' && r.item.role === 'assistant').map((r) => itemText(r.item)).join('\n').trim();
    if (assistant) {
      this.worker.enqueue({
        id: `packet_${Date.now()}`,
        at: new Date().toISOString(),
        events: [],
        assistant,
        scope: this.lastScope,
        source: this.lastDelivery?.source,
        priority: 80,
      });
    }
    const mood = this.mood.current();
    const threads = this.attention.current().threads.filter((t) => t.status !== 'closed').slice(0, 2).map((t) => t.title);
    this.core?.injectInternal(
      `[handoff] 当前心情：${mood.label}；未完成：${threads.join(' | ') || '无'}。继续时先看状态卡，不要假设上下文完整。`,
      'handoff',
    );
    return { tail: null };
  }

  // -------------------------------------------------------------------------
  // 动态头
  // -------------------------------------------------------------------------

  sessionHead(): Item[] {
    this.initStores();
    const cfg = this.opts.config();
    const mood = this.mood.current();
    const relationship = this.relationship.get(this.lastScope);
    const planText = this.lastPlan
      ? renderTurnPlan(this.lastPlan, this.lastDelivery ? formatDeliveryPlan(this.lastDelivery) : '无')
      : '';
    const card = buildStateCard({
      mood,
      relationship,
      attention: this.attention.current(),
      planText,
      deliveryText: this.lastDelivery ? formatDeliveryPlan(this.lastDelivery) : '',
      memoryCards: this.lastMemoryCards,
      tokenBudget: cfg.memory.hotTokenBudget + cfg.retrieval.tokenBudget,
    });
    return [{
      type: 'message',
      id: 'msg_heart_head',
      status: 'completed',
      role: 'user',
      content: [{ type: 'input_text', text: card }],
    }];
  }

  // -------------------------------------------------------------------------
  // WebUI
  // -------------------------------------------------------------------------

  webUi(language: 'zh' | 'en' = 'zh'): PersonaWebUiDecl {
    const zh = language === 'zh';
    return {
      panels: [
        { id: 'heart', title: zh ? '心' : 'Heart', getMethods: ['status', 'memories'] },
        { id: 'service', title: zh ? '服务' : 'Service', getMethods: ['probe'] },
      ],
      memory: {
        panels: [
          { id: 'memories', title: zh ? '记忆' : 'Memories', getMethods: ['list', 'read', 'stats', 'identity_pending'] },
          { id: 'decisions', title: zh ? '决策' : 'Decisions', getMethods: ['traces'] },
        ],
        storage: [
          {
            key: 'heart-db',
            label: zh ? '记忆库' : 'Memory DB',
            kind: 'disk',
            location: 'memory/heart.db',
            danger: true,
            note: zh ? 'SQLite 运行真源；清空请用备份/恢复，不通过这里的清除按钮。' : 'SQLite source of truth; use backup/restore, not the clear button.',
            stat: () => {
              const stats = this.store?.stats();
              return stats ? `${stats.active} 条 · ${(stats.dbBytes / 1024).toFixed(1)}KB` : '未启动';
            },
            clear: () => { throw new Error(zh ? '记忆库不能在这里清空；请用备份/恢复流程。' : 'Use the backup/restore flow; the DB cannot be cleared here.'); },
          },
          {
            key: 'heart-decisions',
            label: zh ? '决策 trace' : 'Decision traces',
            kind: 'disk',
            location: 'memory/decisions/',
            stat: () => `${this.countFiles('decisions')} 个文件`,
            clear: () => {
              for (const name of this.listFiles('decisions')) rmSync(join(this.memoryDir, 'decisions', name), { force: true });
              return zh ? '已清空决策 trace。' : 'Decision traces cleared.';
            },
          },
          {
            key: 'heart-export',
            label: zh ? '导出' : 'Exports',
            kind: 'disk',
            location: 'memory/export/',
            stat: () => `${this.countFiles('export')} 个文件`,
            clear: () => {
              for (const name of this.listFiles('export')) rmSync(join(this.memoryDir, 'export', name), { force: true });
              return zh ? '已清空导出。' : 'Exports cleared.';
            },
          },
        ],
      },
      invoke: async (panel, method, args) => this.invoke(panel, method, args),
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    this.initStores();
    if ((panel === 'heart' && method === 'status') || (panel === 'memories' && method === 'stats')) {
      return {
        mood: this.mood.current(),
        relationship: this.relationship.get(this.lastScope),
        attention: this.attention.current(),
        plan: this.lastPlan,
        delivery: this.lastDelivery,
        trace: this.lastTrace,
        stats: this.store.stats(),
        worker: { pending: this.worker.pending, busy: this.worker.busy },
        backend: this.store.backend,
      };
    }
    if ((panel === 'heart' && method === 'memories') || (panel === 'memories' && method === 'list')) {
      const filter = (args[0] ?? {}) as { query?: string; kind?: string; tier?: string; limit?: number };
      if (filter.query) {
        return this.store.search({ text: filter.query, limit: Math.min(50, filter.limit ?? 20) }).map((h) => h.record);
      }
      return this.store.list({
        kinds: filter.kind ? [filter.kind as never] : undefined,
        tiers: filter.tier ? [filter.tier as never] : undefined,
        limit: Math.min(100, filter.limit ?? 50),
        orderBy: 'updated',
      });
    }
    if (panel === 'memories' && method === 'read') {
      const id = String(args[0] ?? '');
      return this.store.get(id) ?? null;
    }
    if (panel === 'memories' && method === 'identity_pending') {
      return this.store.getState<MemoryCandidate[]>('identity:pending') ?? [];
    }
    if (panel === 'memories' && method === 'identity_approve') {
      const pending = this.store.getState<MemoryCandidate[]>('identity:pending') ?? [];
      const index = Number(args[0]);
      if (!Number.isInteger(index) || index < 0 || index >= pending.length) return { ok: false, error: 'invalid index' };
      const [candidate] = pending.splice(index, 1);
      this.store.setState('identity:pending', pending);
      if (!candidate) return { ok: false, error: 'missing candidate' };
      this.worker.enqueueExplicit({ ...candidate, approved: true }, candidate.scope, 'operator');
      return { ok: true };
    }
    if (panel === 'memories' && method === 'identity_reject') {
      const pending = this.store.getState<MemoryCandidate[]>('identity:pending') ?? [];
      const index = Number(args[0]);
      if (!Number.isInteger(index) || index < 0 || index >= pending.length) return { ok: false, error: 'invalid index' };
      const [candidate] = pending.splice(index, 1);
      this.store.setState('identity:pending', pending);
      if (candidate) this.store.apply([{ op: 'skip', candidate, reason: 'operator rejected identity candidate' }]);
      return { ok: true };
    }
    if (panel === 'memories' && method === 'forget') {
      const id = String(args[0] ?? '');
      if (args[1] !== true) return { ok: false, error: '需要操作者确认（confirm=true）' };
      return { ok: this.store.forget(id, 'soft') };
    }
    if (panel === 'memories' && method === 'export') {
      const path = join(this.memoryDir, 'export', 'records.jsonl');
      return { path, count: this.store.exportJsonl(path) };
    }
    if (panel === 'memories' && method === 'consolidate') {
      return consolidate({ store: this.store, warmLimit: this.opts.config().memory.warmLimit });
    }
    if (panel === 'service' && method === 'probe') {
      const cfg = this.opts.config();
      return probeService({
        baseUrl: cfg.decision.serviceUrl,
        token: this.secret(cfg.decision.tokenSecret),
        timeoutMs: Math.max(300, cfg.decision.timeoutMs),
      });
    }
    if (panel === 'decisions' && method === 'traces') {
      return this.lastTrace ? [this.lastTrace] : [];
    }
    throw new Error(`heart 面板没有 ${panel}.${method}`);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private listFiles(sub: 'decisions' | 'export'): string[] {
    const dir = join(this.memoryDir, sub);
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()); } catch { return []; }
  }

  private countFiles(sub: 'decisions' | 'export'): number {
    return this.listFiles(sub).length;
  }

  private identityText(): string {
    if (!this.store) return `我是 ${this.opts.config().identity.displayName}。`;
    const records = this.store.list({ kinds: ['identity'], status: ['active'], limit: 8, orderBy: 'salience' });
    if (records.length > 0) return identityView(records);
    return `我是 ${this.opts.config().identity.displayName}。我的记忆、判断和说话方式构成连续性。`;
  }

  private recentText(): string {
    const snapshot = this.core?.sessionInfo(MAIN).snapshot ?? [];
    return snapshot
      .filter((r) => r.item.type === 'message' && (r.item.role === 'user' || r.item.role === 'assistant'))
      .slice(-8)
      .map((r) => `${r.item.type === 'message' ? r.item.role : ''}: ${itemText(r.item).slice(0, 400)}`)
      .join('\n');
  }

  private recentAssistantCount(): number {
    const snapshot = this.core?.sessionInfo(MAIN).snapshot ?? [];
    return snapshot.filter((r) => r.item.type === 'message' && r.item.role === 'assistant').length;
  }

  private flushPacket(): void {
    if (this.pendingEvents.length === 0 && !this.assistantBuffer.trim()) return;
    const packet: MemoryPacket = {
      id: `packet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      events: this.pendingEvents.splice(0),
      assistant: this.assistantBuffer.trim(),
      scope: this.lastScope,
      source: this.lastDelivery?.source,
      priority: this.lastPlan?.action === 'respond' ? 60 : 40,
    };
    this.assistantBuffer = '';
    this.calledTools.clear();
    this.worker.enqueue(packet);
  }

  private scheduleConsolidation(): void {
    const core = this.core;
    if (!core) return;
    const cfg = this.opts.config();
    const at = new Date(Date.now() + Math.max(1, cfg.consolidation.idleMinutes) * 60_000).toISOString();
    core.timers.set(at, { kind: 'consolidate' });
  }

  private runConsolidation(): void {
    const cfg = this.opts.config();
    this.lastConsolidation = Date.now();
    try {
      const result = consolidate({ store: this.store, warmLimit: cfg.memory.warmLimit });
      if (result.merged + result.promoted + result.demoted > 0) {
        this.opts.logger?.info('记忆巩固完成', result);
      }
    } catch (err) {
      this.opts.logger?.warn('记忆巩固失败', { error: (err as Error)?.message ?? String(err) });
    }
  }

  private makeEmbedding(): EmbeddingService | null {
    const cfg = this.opts.config();
    if (!cfg.vectors.enabled || !cfg.vectors.serviceUrl) return null;
    return new HttpEmbeddingService({
      baseUrl: cfg.vectors.serviceUrl,
      token: this.secret(cfg.vectors.tokenSecret),
      embeddingModel: cfg.vectors.embeddingModel,
      rerankModel: cfg.vectors.rerankModel,
      dim: cfg.vectors.dim,
      batch: cfg.vectors.batch,
      timeoutMs: cfg.vectors.timeoutMs,
      fetch: globalThis.fetch,
    });
  }

  private makeRerank(): RerankService | null {
    const cfg = this.opts.config();
    if (!cfg.vectors.enabled || !cfg.vectors.serviceUrl) return null;
    return new HttpRerankService({
      baseUrl: cfg.vectors.serviceUrl,
      token: this.secret(cfg.vectors.tokenSecret),
      embeddingModel: cfg.vectors.embeddingModel,
      rerankModel: cfg.vectors.rerankModel,
      dim: cfg.vectors.dim,
      timeoutMs: cfg.vectors.timeoutMs,
      fetch: globalThis.fetch,
    });
  }

  /** 决策/向量参数热改时重建客户端；worker 拿到新引用，已入队的包不重跑。 */
  private refreshClients(): void {
    if (!this.decision) return;
    const key = this.currentClientKey();
    if (key === this.clientKey) return;
    this.embedding = this.makeEmbedding();
    this.rerank = this.makeRerank();
    this.decision = this.makeDecision();
    this.worker.setClients(this.decision, this.opts.config().memory.autoEmbedding ? this.embedding : null);
    this.clientKey = key;
  }

  private currentClientKey(): string {
    const cfg = this.opts.config();
    return JSON.stringify({
      decision: cfg.decision,
      vectors: cfg.vectors,
      autoEmbedding: cfg.memory.autoEmbedding,
    });
  }

  private makeDecision(): DecisionPlane {
    const cfg = this.opts.config();
    const client = cfg.decision.enabled && cfg.decision.serviceUrl
      ? new SystemOneClient({
        baseUrl: cfg.decision.serviceUrl,
        token: this.secret(cfg.decision.tokenSecret),
        model: cfg.decision.systemoneModel,
        timeoutMs: cfg.decision.timeoutMs,
      })
      : null;
    return new DecisionPlane({
      client,
      timeoutMs: cfg.decision.timeoutMs,
      confidenceThreshold: cfg.decision.confidenceThreshold,
      onTrace: (trace) => this.trace(trace),
    });
  }

  private secret(name: string): string {
    try { return name ? this.opts.secret(name) : ''; } catch { return ''; }
  }

  private trace(trace: DecisionTrace): void {
    try {
      const date = trace.at.slice(0, 10);
      appendFileSync(join(this.memoryDir, 'decisions', `${date}.jsonl`), JSON.stringify(trace) + '\n', 'utf8');
    } catch { /* trace 写失败不影响回合 */ }
  }
}

/** 结束本轮的工具。Core 只认 endsTurn；名字与措辞归 Persona。 */
export function endTurnTool(): ToolDef {
  return { ...END_TURN_DECL, handler: async () => '[turn ended]' };
}

function isIncoming(event: EventEnvelope): boolean {
  if (event.type.endsWith('.self')) return false;
  if (event.source === 'persona' || event.source === 'core') return false;
  if (event.source === 'console') return event.type === 'console.message' || event.type === 'console.invite';
  return event.origin === 'external';
}

function isAddressed(events: readonly EventEnvelope[], displayName: string): boolean {
  if (events.some((e) => e.source === 'console' && (e.type === 'console.message' || e.type === 'console.invite'))) return true;
  if (isPrivateConversation(events)) return true;
  return events.some((e) => {
    if (e.meta?.mentionedSelf === true || e.meta?.addressed === true) return true;
    const text = e.text;
    return text.includes(`@${displayName}`) || text.includes('@你') || text.includes('@我') || text.includes('@Kmch');
  });
}

function isMentioned(events: readonly EventEnvelope[], displayName: string): boolean {
  return events.some((e) => e.meta?.mentionedSelf === true || e.text.includes(`@${displayName}`) || e.text.includes('@你') || e.text.includes('@我'));
}

function convKind(events: readonly EventEnvelope[]): string | undefined {
  for (const e of events) {
    const conv = e.meta?.conv;
    if (conv && typeof conv === 'object' && typeof (conv as { kind?: unknown }).kind === 'string') {
      return (conv as { kind: string }).kind;
    }
  }
  return undefined;
}

function isPrivateConversation(events: readonly EventEnvelope[]): boolean {
  return convKind(events) === 'private' || events.some((e) => typeof e.meta?.conv === 'string' && e.meta.conv.startsWith('private:'));
}

function isGroupConversation(events: readonly EventEnvelope[]): boolean {
  return convKind(events) === 'group' || events.some((e) => typeof e.meta?.conv === 'string' && e.meta.conv.startsWith('group:'));
}


function userRecord(text: string): ContextRecord {
  return {
    version: 2,
    item: {
      type: 'message',
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'completed',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
    context: {},
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(200, timeoutMs));
        timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
