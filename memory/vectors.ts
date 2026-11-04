/**
 * 向量与重排客户端。
 *
 * 服务侧 `/v1/embeddings`、`/v1/rerank` 还没有时返回 null/false，调用方降级到词法与
 * 加权分数。所有请求有超时和批量上限，不把大段文本塞回主上下文。
 */
import type { RerankScore } from '../decision/types.ts';

export interface EmbeddingService {
  embed(texts: readonly string[]): Promise<number[][] | null>;
}

export interface RerankService {
  rerank(query: string, documents: readonly string[], topN?: number): Promise<RerankScore[] | null>;
}

export interface HttpVectorOptions {
  baseUrl: string;
  token?: string;
  embeddingModel: string;
  rerankModel: string;
  dim: number;
  batch?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function postJson(
  opts: HttpVectorOptions,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const f = opts.fetch ?? globalThis.fetch;
    return await f(joinUrl(opts.baseUrl, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export class HttpEmbeddingService implements EmbeddingService {
  constructor(private readonly opts: HttpVectorOptions) {}

  async embed(texts: readonly string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    const batch = Math.max(1, Math.min(64, this.opts.batch ?? 64));
    const timeout = this.opts.timeoutMs ?? 3000;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      try {
        const res = await postJson(this.opts, '/v1/embeddings', {
          model: this.opts.embeddingModel,
          input: slice,
          dimensions: this.opts.dim,
        }, timeout);
        if (!res.ok) return null;
        const body = await res.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
        if (!Array.isArray(body.data) || body.data.length !== slice.length) return null;
        const ordered = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const item of ordered) {
          if (!Array.isArray(item.embedding) || item.embedding.length !== this.opts.dim) return null;
          out.push(item.embedding);
        }
      } catch {
        return null;
      }
    }
    return out;
  }
}

export class HttpRerankService implements RerankService {
  constructor(private readonly opts: HttpVectorOptions) {}

  async rerank(query: string, documents: readonly string[], topN = 20): Promise<RerankScore[] | null> {
    if (documents.length === 0) return [];
    try {
      const res = await postJson(this.opts, '/v1/rerank', {
        model: this.opts.rerankModel,
        query,
        documents,
        top_n: Math.min(documents.length, Math.max(1, topN)),
      }, this.opts.timeoutMs ?? 3000);
      // 501：本地 llamacpp 没有 rerank 端点，静默降级。
      if (!res.ok) return null;
      const body = await res.json() as { results?: Array<{ index?: number; relevance_score?: number }> };
      if (!Array.isArray(body.results)) return null;
      return body.results
        .filter((r) => typeof r.index === 'number')
        .map((r) => ({ id: String(r.index), score: Math.max(0, Math.min(1, Number(r.relevance_score ?? 0))) }));
    } catch {
      return null;
    }
  }
}

/** 无 embedding 服务时的粗召回向量；只用于同语言近似，不声称语义质量。 */
export function hashEmbedding(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < normalized.length; i++) {
    const gram = normalized.slice(i, Math.min(normalized.length, i + 3));
    let hash = 2166136261;
    for (let j = 0; j < gram.length; j++) {
      hash ^= gram.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
    out[Math.abs(hash) % dim] += 1;
  }
  return normalizeVector(out);
}

export function normalizeVector(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0));
  return norm === 0 ? [...vector] : vector.map((v) => v / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(-1, Math.min(1, dot));
}
