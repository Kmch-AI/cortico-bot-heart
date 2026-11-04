/**
 * Heart 的 Persona 页与 Memory 页面板。
 * 数据面只走 ctx.invoke；判定与存储都在服务端。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface MoodView {
  label: string; valence: number; arousal: number; energy: number;
  tension: number; openness: number; patience: number; playfulness: number; focus: number;
}
interface StatusPayload {
  mood: MoodView;
  plan: { action: string; intent: string; stance: string; voice: boolean; confidence: number } | null;
  delivery: { source: string; text: string; voice: string | null; target?: string } | null;
  stats: { total: number; active: number; hotTokensEstimate: number; byTier: { hot: number; warm: number; cold: number }; vectorEnabled: boolean; ftsEnabled: boolean };
  backend: string;
  worker: { pending: number; busy: boolean };
  trace: { mode: string; latencyMs: number; summary?: string } | null;
}
interface MemoryRow {
  id: string; title: string; content: string; kind: string; tier: string;
  confidence: number; salience: number; status: string; scope: { type: string; id?: string };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function mountHeart(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '心' });
  root.append(card.el);
  card.body.append(ui.placeholder('读取中…'));
  void ctx.invoke<StatusPayload>('status', []).then((s) => {
    if (ctx.signal.aborted) return;
    const box = ui.h('div', 'heart-status');
    const mood = ui.h('div', 'heart-mood');
    mood.append(
      ui.h('div', 'heart-label', s.mood.label),
      ui.h('div', 'heart-metrics', `愉悦 ${s.mood.valence.toFixed(2)} · 能量 ${pct(s.mood.energy)} · 紧张 ${pct(s.mood.tension)} · 玩心 ${pct(s.mood.playfulness)}`),
    );
    const plan = ui.h('div', 'heart-plan');
    plan.append(
      ui.h('div', 'heart-row', `决策 ${s.plan?.action ?? '—'} · ${s.plan?.intent ?? '—'} · 置信 ${s.plan ? pct(s.plan.confidence) : '—'}`),
      ui.h('div', 'heart-row', `交付 ${s.delivery?.source ?? '—'} · 文字 ${s.delivery?.text ?? '—'} · 语音 ${s.delivery?.voice ?? '否'}${s.delivery?.target ? ` · ${s.delivery.target}` : ''}`),
      ui.h('div', 'heart-row', `记忆 ${s.stats.active} 条 · hot ${s.stats.byTier.hot} / warm ${s.stats.byTier.warm} / cold ${s.stats.byTier.cold} · ${s.backend}${s.stats.vectorEnabled ? ' · vec' : ''}${s.stats.ftsEnabled ? ' · fts' : ''}`),
      ui.h('div', 'heart-row', `后台 ${s.worker.busy ? '运行中' : '空闲'} · 队列 ${s.worker.pending}`),
    );
    box.append(mood, plan);
    card.body.replaceChildren(box);
  }, (error: unknown) => {
    if (!ctx.signal.aborted) card.body.replaceChildren(ui.msgline(String(error), true));
  });
}

function mountMemories(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '记忆' });
  root.append(card.el);
  card.body.append(ui.placeholder('读取中…'));
  void ctx.invoke<MemoryRow[]>('list', [{ limit: 50 }]).then((rows) => {
    if (ctx.signal.aborted) return;
    if (rows.length === 0) { card.body.replaceChildren(ui.placeholder('还没有记忆。')); return; }
    const list = ui.h('div', 'heart-memories');
    for (const row of rows) {
      const item = ui.h('div', 'heart-memory');
      item.append(
        ui.h('div', 'heart-memory-title', `${row.title}`),
        ui.h('div', 'heart-memory-meta', `${row.kind} · ${row.tier} · ${row.scope.type}${row.scope.id ? `:${row.scope.id}` : ''} · 置信 ${pct(row.confidence)} · 重要 ${pct(row.salience)}`),
        ui.h('div', 'heart-memory-body', row.content),
      );
      list.append(item);
    }
    card.body.replaceChildren(list);
  }, (error: unknown) => {
    if (!ctx.signal.aborted) card.body.replaceChildren(ui.msgline(String(error), true));
  });
}

function mountDecisions(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '决策' });
  root.append(card.el);
  card.body.append(ui.placeholder('读取中…'));
  void ctx.invoke<Array<{ task: string; mode: string; latencyMs: number; summary?: string }>>('traces', []).then((rows) => {
    if (ctx.signal.aborted) return;
    if (rows.length === 0) { card.body.replaceChildren(ui.placeholder('还没有决策记录。')); return; }
    const list = ui.h('div', 'heart-traces');
    for (const row of rows) {
      list.append(ui.h('div', 'heart-trace', `${row.task} · ${row.mode} · ${row.latencyMs}ms${row.summary ? ` · ${row.summary}` : ''}`));
    }
    card.body.replaceChildren(list);
  }, (error: unknown) => {
    if (!ctx.signal.aborted) card.body.replaceChildren(ui.msgline(String(error), true));
  });
}


function mountService(ctx: WebUiPanelContext): void {
  const { ui, root } = ctx;
  const card = ui.sheet({ title: '服务' });
  root.append(card.el);
  card.body.append(ui.placeholder('探测中…'));
  void ctx.invoke<{ reachable: boolean; systemone: boolean; embeddings: boolean; rerank: boolean; models: string[]; error?: string }>('probe', []).then((p) => {
    if (ctx.signal.aborted) return;
    const box = ui.h('div', 'heart-status');
    box.append(
      ui.h('div', 'heart-row', `服务 ${p.reachable ? '可达' : '不可达'}${p.error ? ` · ${p.error}` : ''}`),
      ui.h('div', 'heart-row', `systemone ${p.systemone ? '有' : '无'} · embeddings ${p.embeddings ? '有' : '无'} · rerank ${p.rerank ? '有' : '无'}`),
      ui.h('div', 'heart-row', `模型 ${p.models.join('、') || '—'}`),
    );
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
