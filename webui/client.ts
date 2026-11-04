/**
 * Heart 的 Persona / Memory 页面板。
 *
 * 参考 cortico-bot-continuity 的组织方式：状态用 statgrid + 卡片，记忆用可搜索的表格 +
 * 抽屉详情，决策 trace 用表格而不是只显示最后一条。数据面仍只走 ctx.invoke；判定与存储
 * 都在服务端。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface MoodView {
  label: string; valence: number; arousal: number; energy: number;
  tension: number; openness: number; patience: number; playfulness: number; focus: number;
}

interface RelationshipView {
  familiarity: number; trust: number; intimacy: number; tension: number; status: string;
}

interface AttentionView {
  topics: string[];
  threads: Array<{ title: string; status: string }>;
  pending: Array<{ text: string }>;
  energy: number;
}

interface PlanView {
  action: string; intent: string; stance: string; voice: boolean; confidence: number;
  cognitiveDepth?: string; length?: string; directness?: string; playfulness?: number;
}

interface DeliveryView {
  source: string; text: string; voice: string | null; target?: string; note?: string;
}

interface TraceView {
  task: string; at: string; mode: string; latencyMs: number;
  confidence?: number; summary?: string; error?: string;
}

interface StatusPayload {
  mood: MoodView;
  relationship: RelationshipView;
  attention: AttentionView;
  plan: PlanView | null;
  delivery: DeliveryView | null;
  trace: TraceView | null;
  stats: {
    total: number; active: number; hotTokensEstimate: number;
    byTier: { hot: number; warm: number; cold: number };
    vectorEnabled: boolean; ftsEnabled: boolean;
  };
  backend: string;
  worker: { pending: number; busy: boolean };
}

interface MemoryRow {
  id: string; title: string; content: string; kind: string; tier: string;
  confidence: number; salience: number; status: string; sensitivity: string;
  subject?: string; scope: { type: string; id?: string };
  valid?: { from: string; to?: string };
  stats?: { createdAt: string; updatedAt: string; accessCount: number; useCount: number };
  evidence?: Array<{ eventId?: string; quote?: string; at: string; source?: string }>;
}

interface PendingIdentity {
  kind: string;
  title: string;
  content: string;
  subject?: string;
  scope: { type: string; id?: string };
}

const KINDS = ['identity', 'relationship', 'preference', 'semantic', 'episodic', 'procedural', 'commitment', 'affective', 'goal'];
const TIERS = ['hot', 'warm', 'cold'];
const pct = (n: number | undefined): string => `${Math.round((n ?? 0) * 100)}%`;
const scopeText = (scope: { type: string; id?: string } | undefined): string =>
  scope ? `${scope.type}${scope.id ? `:${scope.id}` : ''}` : '—';
const timeText = (iso: string | undefined): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso;
};

function mountHeart(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '心', en: 'heart' });
  root.append(card.el);
  const body = ui.h('div', 'heart-grid');
  card.body.append(body);
  body.append(ui.placeholder('读取中…'));

  const paint = (s: StatusPayload): void => {
    const mood = ui.sheet({ title: '状态', en: 'state' });
    mood.body.append(ui.statgrid([
      { k: '心情', v: s.mood.label, accent: true },
      { k: '能量', v: pct(s.mood.energy) },
      { k: '紧张', v: pct(s.mood.tension) },
      { k: '玩心', v: pct(s.mood.playfulness) },
      { k: '记忆', v: s.stats.active, unit: '条' },
      { k: '队列', v: s.worker.pending, unit: '包' },
    ]));
    mood.body.append(ui.msgline(
      `关系 ${s.relationship.status} · 熟悉 ${pct(s.relationship.familiarity)} · 信任 ${pct(s.relationship.trust)}`
      + ` · 亲近 ${pct(s.relationship.intimacy)} · 张力 ${pct(s.relationship.tension)}`,
    ));
    const topics = s.attention.topics.slice(0, 6).join('、') || '无';
    const threads = s.attention.threads.filter((t) => t.status !== 'closed').slice(0, 3).map((t) => t.title).join(' | ') || '无';
    const pending = s.attention.pending.slice(-2).map((p) => p.text).join(' | ') || '无';
    mood.body.append(ui.msgline(`话题 ${topics}`), ui.msgline(`未完成 ${threads}`), ui.msgline(`待接 ${pending}`));

    const turn = ui.sheet({ title: '本轮', en: 'turn' });
    if (!s.plan) {
      turn.body.append(ui.placeholder('还没有回合决策。'));
    } else {
      turn.body.append(ui.kv([
        { k: '动作', v: s.plan.action },
        { k: '意图', v: s.plan.intent },
        { k: '立场', v: s.plan.stance },
        { k: '深度', v: s.plan.cognitiveDepth ?? '—' },
        { k: '长度', v: s.plan.length ?? '—' },
        { k: '直接度', v: s.plan.directness ?? '—' },
        { k: '语音', v: s.plan.voice ? '发' : '不发' },
        { k: '置信', v: pct(s.plan.confidence) },
      ]));
      if (s.delivery) {
        turn.body.append(ui.kv([
          { k: '来源', v: s.delivery.source },
          { k: '文字', v: s.delivery.text },
          { k: '语音', v: s.delivery.voice ?? '没有语音出口' },
          { k: '目标', v: s.delivery.target ?? '—' },
        ]));
        if (s.delivery.note) turn.body.append(ui.msgline(s.delivery.note));
      }
      if (s.trace) {
        const line = `${s.trace.task} · ${s.trace.mode} · ${s.trace.latencyMs}ms`
          + `${s.trace.summary ? ` · ${s.trace.summary}` : ''}${s.trace.error ? ` · ${s.trace.error}` : ''}`;
        turn.body.append(ui.msgline(line, !!s.trace.error));
      }
    }

    const memory = ui.sheet({ title: '记忆与后台', en: 'memory' });
    memory.body.append(ui.statgrid([
      { k: 'hot', v: s.stats.byTier.hot },
      { k: 'warm', v: s.stats.byTier.warm },
      { k: 'cold', v: s.stats.byTier.cold },
      { k: '常驻 token', v: s.stats.hotTokensEstimate },
    ]));
    memory.body.append(ui.msgline(
      `后端 ${s.backend} · 向量 ${s.stats.vectorEnabled ? '开' : '关'} · FTS ${s.stats.ftsEnabled ? '开' : '关'}`
      + ` · 后台 ${s.worker.busy ? '运行中' : '空闲'} · 队列 ${s.worker.pending}`,
    ));
    body.replaceChildren(mood.el, turn.el, memory.el);
  };

  const load = async (): Promise<void> => {
    try {
      const s = await ctx.invoke<StatusPayload>('status', []);
      if (!ctx.signal.aborted) paint(s);
    } catch (error) {
      if (!ctx.signal.aborted) body.replaceChildren(ui.msgline(String(error), true));
    }
  };
  void load();
  ctx.interval(() => { void load(); }, 5000);
}

function mountMemories(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '记忆', en: 'memory' });
  root.append(card.el);

  const search = ui.input({ type: 'search', placeholder: '搜索标题、正文、主体', onCommit: () => { void reload(); } });
  const kind = ui.select({
    value: '',
    options: [{ value: '', label: '全部类型' }, ...KINDS.map((value) => ({ value, label: value }))],
    onInput: () => { void reload(); },
  });
  const tier = ui.select({
    value: '',
    options: [{ value: '', label: '全部层级' }, ...TIERS.map((value) => ({ value, label: value }))],
    onInput: () => { void reload(); },
  });
  const limit = ui.select({
    value: '50',
    options: [{ value: '20', label: '20 条' }, { value: '50', label: '50 条' }, { value: '100', label: '100 条' }],
    onInput: () => { void reload(); },
  });
  const refresh = ui.button('刷新', { size: 'sm', onClick: () => { void reload(); } });
  const toolbar = ui.rowbar();
  toolbar.append(search, kind, tier, limit, ui.h('span', 'grow'), refresh);

  const pendingBox = ui.h('div');
  const listBox = ui.h('div');
  card.body.append(toolbar, pendingBox, listBox);
  listBox.append(ui.placeholder('读取中…'));
  let seq = 0;

  const reload = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const [rows, pending] = await Promise.all([
        ctx.invoke<MemoryRow[]>('list', [{
          query: search.value.trim() || undefined,
          kind: kind.value || undefined,
          tier: tier.value || undefined,
          limit: Number(limit.value),
        }]),
        ctx.invoke<PendingIdentity[]>('identity_pending', []).catch(() => [] as PendingIdentity[]),
      ]);
      if (ctx.signal.aborted || mine !== seq) return;
      paintPending(pending);
      paintList(rows);
    } catch (error) {
      if (!ctx.signal.aborted && mine === seq) listBox.replaceChildren(ui.msgline(String(error), true));
    }
  };

  const paintPending = (pending: PendingIdentity[]): void => {
    pendingBox.replaceChildren();
    if (!pending.length) return;
    const sheet = ui.sheet({ title: '待审核心身份', en: 'identity review' });
    pending.forEach((row, index) => {
      const item = ui.h('div', 'heart-memory');
      const actions = ui.actions();
      const act = (method: string): void => {
        void ctx.invoke(method, [index]).then(() => reload(), (error: unknown) => {
          if (!ctx.signal.aborted) sheet.body.append(ui.msgline(String(error), true));
        });
      };
      actions.append(
        ui.button('批准', { variant: 'primary', size: 'sm', onClick: () => act('identity_approve') }),
        ui.button('拒绝', { variant: 'plain', size: 'sm', onClick: () => act('identity_reject') }),
      );
      item.append(
        ui.h('div', 'heart-memory-title', row.title),
        ui.h('div', 'heart-memory-meta', `${row.kind} · ${scopeText(row.scope)}${row.subject ? ` · ${row.subject}` : ''}`),
        ui.h('div', 'heart-memory-body', row.content),
        actions,
      );
      sheet.body.append(item);
    });
    pendingBox.append(sheet.el);
  };

  const paintList = (rows: MemoryRow[]): void => {
    if (!rows.length) {
      listBox.replaceChildren(ui.placeholder(search.value.trim() ? '没有匹配的记忆。' : '还没有记忆。'));
      return;
    }
    const table = ui.table({ head: ['记忆', '类型 / 层', '范围', '置信 / 重要', ''], maxHeight: 'calc(100vh - 300px)' });
    for (const row of rows) {
      const title = ui.h('div');
      title.append(
        ui.h('div', 'heart-memory-title', row.title),
        ui.h('div', 'heart-memory-body', row.content.length > 220 ? `${row.content.slice(0, 220)}…` : row.content),
      );
      const meta = ui.h('div', 'heart-memory-meta');
      meta.append(ui.pill(row.kind, 'plain'), ui.pill(row.tier, row.tier === 'hot' ? 'on' : 'off'));
      const confidence = ui.h('div', 'heart-memory-meta', `${pct(row.confidence)} / ${pct(row.salience)}`);
      const view = ui.button('查看', { size: 'sm', onClick: () => { void show(row); } });
      table.addRow([{ el: title }, { el: meta }, { text: scopeText(row.scope), cls: 'mono' }, { el: confidence }, { el: view }]);
    }
    listBox.replaceChildren(table.el);
  };

  const show = async (row: MemoryRow): Promise<void> => {
    try {
      const record = await ctx.invoke<MemoryRow>('read', [row.id]);
      if (ctx.signal.aborted) return;
      const body = ui.h('div');
      body.append(ui.kv([
        { k: 'id', v: record.id },
        { k: '类型', v: record.kind },
        { k: '层级', v: record.tier },
        { k: '范围', v: scopeText(record.scope) },
        { k: '主体', v: record.subject ?? '—' },
        { k: '置信', v: pct(record.confidence) },
        { k: '重要', v: pct(record.salience) },
        { k: '敏感', v: record.sensitivity },
        { k: '状态', v: record.status },
        { k: '更新', v: timeText(record.stats?.updatedAt) },
      ]));
      body.append(ui.section('正文'), ui.h('div', 'heart-memory-body', record.content));
      if (record.evidence?.length) {
        const table = ui.table({ head: ['时间', '来源', '引用'] });
        for (const evidence of record.evidence) {
          table.addRow([
            { text: timeText(evidence.at), cls: 'mono' },
            { text: evidence.source ?? evidence.eventId ?? '—', cls: 'mono' },
            { text: evidence.quote ?? '—', cls: 'txt' },
          ]);
        }
        body.append(ui.section('证据'), table.el);
      }
      ui.drawer(record.title, body);
    } catch (error) {
      if (!ctx.signal.aborted) listBox.append(ui.msgline(String(error), true));
    }
  };

  void reload();
}

function mountDecisions(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '决策', en: 'decisions' });
  root.append(card.el);
  const body = ui.h('div');
  const refresh = ui.button('刷新', { size: 'sm', onClick: () => { void load(); } });
  card.body.append(refresh, body);
  body.append(ui.placeholder('读取中…'));

  const load = async (): Promise<void> => {
    try {
      const rows = await ctx.invoke<TraceView[]>('traces', []);
      if (ctx.signal.aborted) return;
      if (!rows.length) { body.replaceChildren(ui.placeholder('还没有决策记录。')); return; }
      const table = ui.table({ head: ['时间', '任务', '模式', '耗时', '置信', '摘要'], maxHeight: 'calc(100vh - 260px)' });
      for (const row of rows) {
        const summary = ui.h('div', row.error ? 'heart-bad' : 'heart-memory-meta', row.error ?? row.summary ?? '—');
        table.addRow([
          { text: timeText(row.at), cls: 'mono' },
          { text: row.task, cls: 'mono' },
          { text: row.mode, cls: 'mono' },
          { text: `${Math.round(row.latencyMs)}ms`, cls: 'mono' },
          { text: row.confidence === undefined ? '—' : pct(row.confidence), cls: 'mono' },
          { el: summary, cls: 'txt' },
        ]);
      }
      body.replaceChildren(table.el);
    } catch (error) {
      if (!ctx.signal.aborted) body.replaceChildren(ui.msgline(String(error), true));
    }
  };
  void load();
  ctx.interval(() => { void load(); }, 10000);
}

function mountService(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '服务', en: 'service' });
  root.append(card.el);
  card.body.append(ui.placeholder('探测中…'));
  void ctx.invoke<{ reachable: boolean; systemone: boolean; embeddings: boolean; rerank: boolean; models: string[]; error?: string }>('probe', []).then((p) => {
    if (ctx.signal.aborted) return;
    const box = ui.h('div', 'heart-grid');
    box.append(ui.statgrid([
      { k: '服务', v: p.reachable ? '可达' : '不可达', accent: p.reachable },
      { k: 'SystemOne', v: p.systemone ? '有' : '无' },
      { k: 'Embeddings', v: p.embeddings ? '有' : '无' },
      { k: 'Rerank', v: p.rerank ? '有' : '无' },
    ]));
    if (p.error) box.append(ui.msgline(p.error, true));
    const models = ui.h('div', 'heart-chips');
    for (const model of p.models) models.append(ui.chip(model));
    box.append(ui.section('模型'), models.childElementCount ? models : ui.placeholder('没有模型。'));
    card.body.replaceChildren(box);
  }, (error: unknown) => {
    if (!ctx.signal.aborted) card.body.replaceChildren(ui.msgline(String(error), true));
  });
}

const bundle: WebUiClientBundle = {
  panels: {
    heart: { mount: mountHeart },
    service: { mount: mountService },
    memories: { mount: mountMemories },
    decisions: { mount: mountDecisions },
  },
};

export default bundle;
