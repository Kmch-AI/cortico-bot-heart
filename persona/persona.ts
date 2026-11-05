/**
 * Heart Persona：前缀、主 session、回合决策、状态头、记忆 worker 的接线处。
 *
 * 边界：
 * - 不直接执行 World 工具；语音/QQ 由主模型按 DeliveryPlan 调用。
 * - 钩子不 await 记忆任务；只入队，worker 在后台串行处理。
 * - 沉默是语义沉默：注入一句“不要回应”，主模型仍会跑一次并自行 end_turn。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BlobStore,
  CoreApi,
  OutputTap,
  Logger,
  ModelSpec,
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
import { runDirectText } from '../memory/runtime.ts';
import { memoryTools, memoryToolDecls } from '../memory/tools.ts';
import { retrieveMemories } from '../memory/retrieve.ts';
import { consolidate } from '../memory/consolidate.ts';
import { EmbeddingService, HttpEmbeddingService, HttpRerankService, RerankService } from '../memory/vectors.ts';
import { DecisionPlane, type DecisionTrace } from '../decision/fallback.ts';
import { SystemOneClient } from '../decision/systemone.ts';
import { turnPlanState } from '../decision/questions.ts';
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

const MAIN = 'main';

const NOOP_LOG: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  emit: () => {},
  child: () => NOOP_LOG,
};

export interface HeartPersonaOptions {
  memoryDir: string;
  packageDir: string;
  /** 部署侧的提示词覆盖目录（<部署根>/prompts）；文件不存在时回落到包内模板。 */
  promptDir: string;
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
  /** 本批用户是否明确要求记住；memory_note 与后台提取据此标 explicit。 */
  private explicitMemoryRequested = false;
  private turns = 0;
  private lastVoiceTurn: number | null = null;
  private lastConsolidation = 0;
  private shutdownDone = false;
  private clientKey = '';
  private consolidationTimerId: string | null = null;

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
        this.consolidationTimerId = null;
        this.runConsolidation();
        this.scheduleConsolidation();
      }
    });
    // 上一进程留下的同类定时器会重复触发；接管时先清掉。
    for (const timer of core.timers.list()) {
      if (timer.payload?.kind === 'consolidate') core.timers.cancel(timer.id);
    }
    this.scheduleConsolidation();
    core.log.info('heart attached', {
      memoryDir: this.memoryDir,
      backend: this.store.backend,
      vector: this.store.vectorEnabled,
    });
  }

  /** BotParts.onStop 调用；先停 worker，再 checkpoint/关闭 SQLite。 */
  shutdown(): void {
    if (this.shutdownDone || !this.store) return;
    this.shutdownDone = true;
    if (this.consolidationTimerId && this.core) {
      this.core.timers.cancel(this.consolidationTimerId);
      this.consolidationTimerId = null;
    }
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
      llm: () => this.core?.llm ?? null,
      spec: () => this.activeSpec(),
      log: this.core?.log ?? NOOP_LOG,
      store: this.store,
      decision: this.decision,
      embedding: cfg.memory.autoEmbedding ? this.embedding : null,
      queueLimit: cfg.worker.queueLimit,
      timeoutMs: cfg.worker.timeoutMs,
      warmLimit: cfg.memory.warmLimit,
      selfNames: this.selfNames(),
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
    // 基础模板来自包内，始终只读；只有 CUSTOM.md 允许部署覆盖。
    const readBase = (name: string): string => {
      const path = this.packagePromptSource(name);
      return existsSync(path) ? readTextFile(path) : '';
    };
    const custom = this.customPromptText();
    const vars = {
      'persona.identity': identity,
      'persona.displayName': cfg.identity.displayName,
      'persona.custom': custom,
      'worlds.envPrompts': envPrompts,
    };
    // 在 CUSTOM 占位符处切开：标题在前，正文在后，用户人设作为独立可编辑段插在中间。
    const rawPrefix = readBase('PREFIX.md');
    const marker = '{{persona.custom}}';
    const [before, after] = rawPrefix.includes(marker) ? rawPrefix.split(marker) : [rawPrefix, ''];
    const head = renderTemplate(before, vars).replace(/\n{3,}/g, '\n\n').trim();
    const body = renderTemplate(after, vars).replace(/\n{3,}/g, '\n\n').trim();
    const behavior = renderTemplate(readBase('BEHAVIOR.md'), vars).replace(/\n{3,}/g, '\n\n').trim();
    const memoryProtocol = renderTemplate(readBase('MEMORY_PROTOCOL.md'), vars).replace(/\n{3,}/g, '\n\n').trim();
    return [
      { title: 'PREFIX', text: head ? `${head}\n\n` : '' },
      { title: 'CUSTOM', text: custom ? `${custom}\n\n` : '', sourceKey: 'persona.custom' },
      { title: 'PREFIX_BODY', text: body ? `${body}\n\n` : '' },
      { title: 'BEHAVIOR', text: behavior ? `${behavior}\n\n` : '' },
      { title: 'MEMORY_PROTOCOL', text: memoryProtocol },
    ].filter((s) => s.text.trim() || s.sourceKey);
  }

  promptVarValues(): Record<string, string> {
    return {
      'persona.identity': this.identityText(),
      'persona.displayName': this.opts.config().identity.displayName,
      'persona.custom': this.customPromptText(),
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
        explicitRequest: () => this.explicitMemoryRequested,
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
      // 内部通知（交接提示等）不产生新的 turn plan；避免把上一批的计划当成这一批的。
      this.lastPlan = null;
      this.lastDelivery = null;
      this.lastMemoryCards = [];
      this.explicitMemoryRequested = false;
      return;
    }
    const cfg = this.opts.config();
    const last = incoming[incoming.length - 1]!;
    const text = incoming.map((e) => e.text).join('\n').slice(0, 4000);
    this.explicitMemoryRequested = isExplicitMemoryRequest(text);

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
      explicitMemoryRequested: this.explicitMemoryRequested,
    };
    const state = turnPlanState({
      eventSummary: text,
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
      input,
    });

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

    // 用户明确要求记住时，当回合必须有一句回复；自主记忆仍然可以沉默。
    if (plan.action !== 'respond' && route.text !== 'none'
      && (input.addressed || input.isPrivate) && input.explicitMemoryRequested) {
      plan.action = 'respond';
      plan.reason += '; explicit_memory_request';
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
    } else if (plan.action !== 'respond') {
      // 沉默/暂缓批次不会真的发语音，不能消耗冷却。
      plan.voice = false;
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
        const spec = this.activeSpec();
        if (!spec) throw new Error('没有可用模型');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('arbiter timeout')), Math.max(200, cfg.output.timeoutMs));
        timer.unref?.();
        let text = '';
        try {
          // 直连 core.llm：不创建 fork session，控制台不会为候选生成多出一个窗口。
          text = await runDirectText({
            llm: this.core.llm,
            spec,
            messages: [userRecord(brief)],
            log: this.core.log,
            role: 'arbiter',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
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

    if (plan.action === 'silence' || plan.action === 'defer') {
      if (plan.action === 'defer') this.attention.defer(text, last.source);
      this.core?.injectInternal(
        plan.action === 'silence'
          ? '[attention] 这一批不值得回应。不要输出正文，不要调用发送工具，直接 end_turn。'
          : '[attention] 这一批先不接；已记到未完成线程。不要输出正文，不要调用发送工具，直接 end_turn。',
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
    if (!this.lastPlan?.voice) return;
    if (this.calledTools.has('voice_speak')) {
      // 只有真的调用过语音工具才进入冷却。
      this.lastVoiceTurn = this.turns;
      return;
    }
    this.trace({
      task: 'voice_miss', at: new Date().toISOString(), mode: 'skipped', latencyMs: 0,
      summary: `plan wanted voice, tools=${[...this.calledTools].join(',') || 'none'}`,
    });
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

  async onHandoff(_snapshot: ContextRecord[]): Promise<{ tail: ContextRecord[] | null }> {
    this.initStores();
    this.flushPacket();
    // 助手正文已由 onBatchEnd / 本次 flushPacket 入队；不要再从快照重复提取同一段。
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
    const started = !!this.store;
    return {
      badges: [
        { label: zh ? '心情' : 'Mood', value: started ? this.mood.current().label : '—' },
        { label: zh ? '记忆' : 'Memory', value: started ? this.store.stats().active : '—' },
        {
          label: zh ? '后台' : 'Worker',
          value: started ? (this.worker.busy ? `${zh ? '运行' : 'busy'} · ${this.worker.pending}` : (zh ? '空闲' : 'idle')) : '—',
          tone: started && this.worker.busy ? 'on' : 'off',
        },
      ],
      panels: [
        { id: 'heart', title: zh ? '心' : 'Heart', getMethods: ['status', 'memories'] },
        { id: 'service', title: zh ? '服务' : 'Service', getMethods: ['probe'] },
      ],
      promptDocs: [
        {
          key: 'persona.custom',
          title: zh ? '自定义人设' : 'Custom persona',
          description: zh
            ? '你写的人设/人格提示词，插在 PREFIX 顶部；留空则不加。可用 {{persona.displayName}} 和 {{persona.identity}}。'
            : 'Your own persona prompt, inserted at the top of PREFIX; leave empty to omit. Supports {{persona.displayName}} and {{persona.identity}}.',
          path: this.customPromptSource('CUSTOM.md'),
          deploymentPath: join(this.opts.promptDir, 'CUSTOM.md'),
          vars: [
            { name: 'persona.displayName', description: zh ? '当前显示名。' : 'Current display name.' },
            { name: 'persona.identity', description: zh ? 'identity 记忆摘要；没有记录时用默认自述。' : 'Identity memory summary, or the default self-description.', multiline: true },
          ],
        },
        {
          key: 'persona.prefix',
          title: 'PREFIX',
          description: zh ? '内置稳定前缀（只读）：身份、表达目标、工具路由。' : 'Built-in stable prefix (read-only): identity, expressive goals, tool routing.',
          path: this.packagePromptSource('PREFIX.md'),
          vars: [
            { name: 'persona.custom', description: zh ? '用户自定义人设；原样插入，留空则不加。' : 'Operator persona prompt; inserted verbatim or omitted when empty.', multiline: true },
            { name: 'persona.identity', description: zh ? 'identity 记录摘要；没有记录时用默认自述。' : 'Identity record summary, or the default self-description.', multiline: true },
            { name: 'persona.displayName', description: zh ? '当前显示名。' : 'Current display name.' },
            { name: 'worlds.envPrompts', description: zh ? '已挂载 World 的环境提示词。' : 'Environment prompts of mounted Worlds.', multiline: true },
          ],
        },
        {
          key: 'persona.behavior',
          title: 'BEHAVIOR',
          description: zh ? '内置交际行为与表达原则（只读）。' : 'Built-in conversational behavior principles (read-only).',
          path: this.packagePromptSource('BEHAVIOR.md'),
        },
        {
          key: 'persona.memoryProtocol',
          title: 'MEMORY_PROTOCOL',
          description: zh ? '内置记忆读写、隐私与冲突处理协议（只读）。' : 'Built-in memory read/write, privacy and conflict protocol (read-only).',
          path: this.packagePromptSource('MEMORY_PROTOCOL.md'),
        },
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
        const limit = Math.min(100, filter.limit ?? 20);
        const rows = this.store.search({ text: filter.query, limit }).map((h) => h.record)
          .filter((r) => !filter.kind || r.kind === filter.kind)
          .filter((r) => !filter.tier || r.tier === filter.tier);
        return rows.slice(0, limit);
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
      return this.recentTraces(50);
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

  /** 最近的决策 trace；按日期文件倒序读，最多 limit 条。 */
  private recentTraces(limit = 50): DecisionTrace[] {
    const files = this.listFiles('decisions').filter((name) => name.endsWith('.jsonl')).sort().reverse();
    const out: DecisionTrace[] = [];
    for (const name of files) {
      let lines: string[];
      try {
        lines = readFileSync(join(this.memoryDir, 'decisions', name), 'utf8').split('\n').filter((line) => line.trim());
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try { out.push(JSON.parse(lines[i]!) as DecisionTrace); } catch { /* 跳过坏行 */ }
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 当前端点的模型参数；后台直连 core.llm 时用它，不经过 fork。 */
  private activeSpec(): ModelSpec | null {
    const cfg = this.opts.config();
    const entry = cfg.providers?.[cfg.activeProvider];
    return entry?.spec ? structuredClone(entry.spec) : null;
  }

  /** 基础模板只从包内读取；部署目录里的同名文件不参与。 */
  private packagePromptSource(name: string): string {
    return join(this.opts.packageDir, 'persona', name);
  }

  /** 用户人设：部署覆盖存在就用它，否则用包内空白模板。 */
  private customPromptSource(name: string): string {
    const override = join(this.opts.promptDir, name);
    return existsSync(override) ? override : join(this.opts.packageDir, 'persona', name);
  }

  /** 读取并渲染用户人设；HTML 注释剥掉，空内容不插入。 */
  private customPromptText(): string {
    const path = this.customPromptSource('CUSTOM.md');
    if (!existsSync(path)) return '';
    const raw = readTextFile(path);
    if (!raw.trim()) return '';
    const rendered = renderTemplate(raw, {
      'persona.displayName': this.opts.config().identity.displayName,
      'persona.identity': this.identityText(),
    });
    return rendered.replace(/<!--[\s\S]*?-->/g, '').trim();
  }

  /** bot 自己的名字/自称；用于把“用户叫什么”从核心身份里分出来。 */
  private selfNames(): string[] {
    const name = this.opts.config().identity.displayName.trim();
    const short = name.split('·').pop()?.trim() ?? '';
    return [name, short, 'heart', '心'].filter((n, i, all) => n.length > 0 && all.indexOf(n) === i);
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
      explicit: this.explicitMemoryRequested,
      priority: this.lastPlan?.action === 'respond' ? 60 : 40,
    };
    this.assistantBuffer = '';
    this.calledTools.clear();
    this.worker.enqueue(packet);
  }

  private scheduleConsolidation(): void {
    const core = this.core;
    if (!core) return;
    if (this.consolidationTimerId) core.timers.cancel(this.consolidationTimerId);
    const cfg = this.opts.config();
    const at = new Date(Date.now() + Math.max(1, cfg.consolidation.idleMinutes) * 60_000).toISOString();
    const result = core.timers.set(at, { kind: 'consolidate' });
    this.consolidationTimerId = result.ok ? result.id : null;
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

// “没记住/不记住”是回忆或否定，不是要求；单列“别忘了”避免被否定前缀吃掉。
const EXPLICIT_MEMORY_REQUEST = /(?<![没不])记住|(?<![没不])记一下|(?<![没不])记下|别忘了|别忘记|remember|don'?t forget|do not forget/i;

/** 用户是否在明确要求保存记忆；这类回合必须回复，不能因为决策层沉默而吞掉。 */
export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT_MEMORY_REQUEST.test(text);
}

function isIncoming(event: EventEnvelope): boolean {
  if (event.type.endsWith('.self')) return false;
  if (event.source === 'persona' || event.source === 'core') return false;
  if (event.source === 'console') return event.type === 'console.message' || event.type === 'console.invite';
  return event.origin === 'external';
}

/** 显示名与其中长度足够的短名；单字短名不做裸文本匹配，避免“开心”这类误判。 */
function addressNames(displayName: string): string[] {
  const short = displayName.split('·').pop()?.trim() ?? '';
  return [displayName, short].filter((n, i, all) => n.length >= 2 && all.indexOf(n) === i);
}

function isAddressed(events: readonly EventEnvelope[], displayName: string): boolean {
  if (events.some((e) => e.source === 'console' && (e.type === 'console.message' || e.type === 'console.invite'))) return true;
  if (isPrivateConversation(events)) return true;
  const names = addressNames(displayName);
  return events.some((e) => {
    if (e.meta?.mentionedSelf === true || e.meta?.addressed === true) return true;
    const text = e.text;
    return text.includes(`@${displayName}`) || names.some((n) => text.includes(n))
      || text.includes('@你') || text.includes('@我') || text.includes('@Kmch');
  });
}

function isMentioned(events: readonly EventEnvelope[], displayName: string): boolean {
  const names = addressNames(displayName);
  return events.some((e) => e.meta?.mentionedSelf === true
    || e.text.includes(`@${displayName}`) || names.some((n) => e.text.includes(n))
    || e.text.includes('@你') || e.text.includes('@我'));
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
  if (convKind(events) === 'private') return true;
  return events.some((e) => {
    const meta = e.meta ?? {};
    if (typeof meta.conv === 'string') return meta.conv.startsWith('private:');
    // 自定义 World 可能只给 user_id；与 ChannelRouter.targetOf 的约定保持一致。
    if (typeof meta.group_id === 'string' && meta.group_id.trim()) return false;
    if (meta.reply_to !== undefined) return false;
    return typeof meta.user_id === 'string' && meta.user_id.trim().length > 0;
  });
}

function isGroupConversation(events: readonly EventEnvelope[]): boolean {
  if (convKind(events) === 'group') return true;
  return events.some((e) => {
    const meta = e.meta ?? {};
    if (typeof meta.conv === 'string') return meta.conv.startsWith('group:');
    return typeof meta.group_id === 'string' && meta.group_id.trim().length > 0;
  });
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

