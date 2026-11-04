/**
 * 注意力状态：当前话题、未完成线程、待办、社交能量、最近发言者。
 *
 * 它是短期状态，可衰减、可被巩固进 warm memory；不把整段聊天记录留在内存里。
 */
import type { MemoryStore } from '../memory/types.ts';

export interface AttentionThread {
  id: string;
  title: string;
  status: 'open' | 'waiting' | 'closed';
  updatedAt: string;
}

export interface AttentionPending {
  text: string;
  at: string;
  source?: string;
}

export interface AttentionState {
  topics: string[];
  threads: AttentionThread[];
  pending: AttentionPending[];
  energy: number;
  lastSpeakers: string[];
  updatedAt: string;
}

export interface AttentionEngineOptions {
  store: MemoryStore;
  /** 注意力状态最多保留多少条话题/线程。 */
  maxTopics?: number;
  maxThreads?: number;
}

const nowIso = (): string => new Date().toISOString();
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const STOP = new Set([
  '这个', '那个', '什么', '怎么', '就是', '不是', '可以', '现在', '今天', '真的', '感觉', '然后',
  'the', 'and', 'that', 'this', 'with', 'have', 'from', 'just',
]);

function topicsFrom(text: string, max = 6): string[] {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()));
  // 中文没有空格时按 2–4 字片段补充；只取少量，避免把句子拆碎。
  const cjk = text.match(/[一-鿿]{2,4}/g) ?? [];
  const all = [...words, ...cjk.filter((w) => !STOP.has(w))];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of all) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

function defaultState(): AttentionState {
  return { topics: [], threads: [], pending: [], energy: 0.55, lastSpeakers: [], updatedAt: nowIso() };
}

export class AttentionEngine {
  private state: AttentionState;
  private readonly store: MemoryStore;
  private readonly maxTopics: number;
  private readonly maxThreads: number;

  constructor(opts: AttentionEngineOptions) {
    this.store = opts.store;
    this.maxTopics = opts.maxTopics ?? 8;
    this.maxThreads = opts.maxThreads ?? 8;
    this.state = this.store.getState<AttentionState>('attention') ?? defaultState();
  }

  current(): AttentionState {
    return { ...this.state, topics: [...this.state.topics], threads: [...this.state.threads], pending: [...this.state.pending] };
  }

  observe(input: {
    text: string;
    source?: string;
    sender?: string;
    at?: string;
    /** 被点名、私聊或直接提问时提高社交能量。 */
    addressed?: boolean;
  }): AttentionState {
    const at = input.at ?? nowIso();
    const topics = topicsFrom(input.text);
    const mergedTopics = [...topics, ...this.state.topics.filter((t) => !topics.includes(t))].slice(0, this.maxTopics);
    const speakers = input.sender
      ? [input.sender, ...this.state.lastSpeakers.filter((s) => s !== input.sender)].slice(0, 5)
      : this.state.lastSpeakers;
    const energy = clamp01(this.state.energy + (input.addressed ? 0.06 : -0.01));
    const questions = /[?？]|吗|呢|怎么|为什么|如何/.test(input.text);
    const threads = questions
      ? [
        { id: `thread_${Date.parse(at) || Date.now()}`, title: input.text.slice(0, 48), status: 'waiting' as const, updatedAt: at },
        ...this.state.threads,
      ].slice(0, this.maxThreads)
      : this.state.threads;
    this.state = { ...this.state, topics: mergedTopics, threads, energy, lastSpeakers: speakers, updatedAt: at };
    this.store.setState('attention', this.state);
    return this.current();
  }

  defer(text: string, source?: string): void {
    this.state = {
      ...this.state,
      pending: [...this.state.pending, { text: text.slice(0, 240), at: nowIso(), source }].slice(-12),
      updatedAt: nowIso(),
    };
    this.store.setState('attention', this.state);
  }

  consumePending(): AttentionPending[] {
    const out = this.state.pending;
    if (out.length > 0) {
      this.state = { ...this.state, pending: [], updatedAt: nowIso() };
      this.store.setState('attention', this.state);
    }
    return out;
  }

  closeThread(id: string): void {
    this.state = {
      ...this.state,
      threads: this.state.threads.map((t) => (t.id === id ? { ...t, status: 'closed', updatedAt: nowIso() } : t)),
      updatedAt: nowIso(),
    };
    this.store.setState('attention', this.state);
  }

  tick(now = new Date()): AttentionState {
    const elapsed = now.getTime() - Date.parse(this.state.updatedAt);
    const factor = Number.isFinite(elapsed) ? Math.pow(0.5, elapsed / (45 * 60_000)) : 1;
    const energy = clamp01(0.55 + (this.state.energy - 0.55) * factor);
    const next = { ...this.state, energy, updatedAt: now.toISOString() };
    this.state = next;
    this.store.setState('attention', next);
    return this.current();
  }
}

export function attentionCard(state: AttentionState): string {
  const topics = state.topics.length ? state.topics.join('、') : '无';
  const open = state.threads.filter((t) => t.status !== 'closed').slice(0, 3).map((t) => t.title);
  const pending = state.pending.slice(-2).map((p) => p.text);
  return [
    `注意力：社交能量 ${Math.round(state.energy * 100)}%`,
    `当前话题：${topics}`,
    open.length ? `未完成线程：${open.join(' | ')}` : '',
    pending.length ? `待接：${pending.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}
