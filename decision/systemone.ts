/**
 * `/v1/systemone` 客户端（TypeSafe Jev wire format）。
 *
 * 只做三件事：校验请求限制、发 HTTP、把错误分成可降级的类别。
 * 不生成文本，不写记忆，不碰 World。
 */
import {
  SystemOneError,
  type SystemOneClientOptions,
  type SystemOneQuestion,
  type SystemOneRequest,
  type SystemOneResponse,
} from './types.ts';

/** 与 StartLux / Transformers 的 /v1/systemone 校验保持一致。 */
const MAX_QUESTIONS = 64;
const MAX_STATE_TOKENS = 65_536;
const MAX_CHOICES = 26;
const MAX_SCORE_LEVELS = 10;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1') && path.startsWith('/v1/')) return `${base}${path.slice(3)}`;
  return `${base}${path}`;
}

function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 3);
}

function validate(req: SystemOneRequest): void {
  const entries = Object.entries(req.questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) {
    throw new SystemOneError('invalid-response', `questions 必须是 1–${MAX_QUESTIONS} 个，当前 ${entries.length}`);
  }
  for (const [id, q] of entries) {
    if (!q || typeof q !== 'object' || !('type' in q)) throw new SystemOneError('invalid-response', `问题 ${id} 缺少 type`);
    if (q.type === 'choice') {
      const n = Object.keys((q as Extract<SystemOneQuestion, { type: 'choice' }>).criteria ?? {}).length;
      if (n < 2 || n > MAX_CHOICES) throw new SystemOneError('invalid-response', `choice ${id} 需要 2–${MAX_CHOICES} 个选项`);
    }
    if (q.type === 'score') {
      const n = (q as Extract<SystemOneQuestion, { type: 'score' }>).criteria?.length ?? 0;
      if (n < 2 || n > MAX_SCORE_LEVELS) throw new SystemOneError('invalid-response', `score ${id} 需要 2–${MAX_SCORE_LEVELS} 级 criteria 数组`);
    }
  }
  if (estimateTokens(req.state) > MAX_STATE_TOKENS) {
    throw new SystemOneError('invalid-response', `state 超过 ${MAX_STATE_TOKENS} tokens，拒绝静默截断`);
  }
}

function parseResponse(raw: unknown): SystemOneResponse {
  if (!raw || typeof raw !== 'object') throw new SystemOneError('invalid-response', '响应不是对象');
  const r = raw as Partial<SystemOneResponse>;
  if (typeof r.model !== 'string' || !r.answers || typeof r.answers !== 'object') {
    throw new SystemOneError('invalid-response', '响应缺少 model/answers');
  }
  for (const [id, answer] of Object.entries(r.answers)) {
    if (!answer || typeof answer !== 'object' || !('type' in answer)) {
      throw new SystemOneError('invalid-response', `答案 ${id} 缺少 type`);
    }
    if (answer.type === 'noul' && typeof (answer as { noul?: unknown }).noul !== 'number') {
      throw new SystemOneError('invalid-response', `答案 ${id} 的 noul 不是数字`);
    }
    if (answer.type === 'choice') {
      const a = answer as { choice?: unknown; probabilities?: unknown };
      // allow_none 时上游可能返回 choice: null（弃权）；交给上层回退，不当作坏响应。
      if (typeof a.choice !== 'string' && a.choice !== null) {
        throw new SystemOneError('invalid-response', `答案 ${id} 的 choice 不是字符串或 null`);
      }
    }
    if (answer.type === 'score') {
      const a = answer as { score?: unknown };
      if (typeof a.score !== 'number' || !Number.isFinite(a.score)) {
        throw new SystemOneError('invalid-response', `答案 ${id} 的 score 不是数值期望等级`);
      }
    }
  }
  return r as SystemOneResponse;
}

export class SystemOneClient {
  private readonly opts: SystemOneClientOptions;
  private failures = 0;
  private openUntil = 0;

  constructor(opts: SystemOneClientOptions) {
    this.opts = opts;
  }

  get circuitOpen(): boolean {
    return this.openUntil > (this.opts.now?.() ?? Date.now());
  }

  async ask(
    req: Omit<SystemOneRequest, 'model'> & { model?: string },
    timeoutMs?: number,
    attempts = 2,
  ): Promise<SystemOneResponse> {
    if (!this.opts.baseUrl) throw new SystemOneError('not-configured', '没有配置服务地址');
    if (this.circuitOpen) throw new SystemOneError('circuit-open', 'SystemOne 熔断中');
    const full: SystemOneRequest = { model: req.model ?? this.opts.model, state: req.state, questions: req.questions };
    validate(full);

    const timeout = Math.max(100, timeoutMs ?? this.opts.timeoutMs);
    const maxAttempts = Math.max(1, Math.min(4, Math.trunc(attempts)));
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        const f = this.opts.fetch ?? globalThis.fetch;
        const res = await f(joinUrl(this.opts.baseUrl, '/v1/systemone'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
          },
          body: JSON.stringify(full),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new SystemOneError('http', `SystemOne HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, res.status);
          if (res.status >= 500 && attempt < maxAttempts - 1) { lastError = err; continue; }
          throw err;
        }
        const parsed = parseResponse(await res.json());
        this.failures = 0;
        return parsed;
      } catch (err) {
        if (err instanceof SystemOneError) {
          if (err.kind === 'http' && (err.status ?? 0) < 500) throw err;
          lastError = err;
        } else if ((err as { name?: string }).name === 'AbortError') {
          lastError = new SystemOneError('timeout', `SystemOne 超时 ${timeout}ms`);
        } else {
          lastError = new SystemOneError('network', (err as Error)?.message ?? '网络错误');
        }
        // 超时已经用完整段预算；再重试只会把等待翻倍。5xx/网络错误仍可按 attempts 重试。
        if (lastError instanceof SystemOneError && lastError.kind === 'timeout') break;
        if (attempt >= maxAttempts - 1) break;
      } finally {
        clearTimeout(timer);
      }
    }
    this.recordFailure();
    throw lastError instanceof SystemOneError ? lastError : new SystemOneError('network', String(lastError));
  }

  private recordFailure(): void {
    this.failures++;
    if (this.failures >= 3) {
      this.openUntil = (this.opts.now?.() ?? Date.now()) + (this.opts.circuitCooldownMs ?? 60_000);
      this.failures = 0;
    }
  }
}
