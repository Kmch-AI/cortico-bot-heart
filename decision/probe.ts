/**
 * 服务能力探测。
 *
 * 服务网关还没有 /v1/systemone、/v1/embeddings、/v1/rerank 时，heart 要能明确降级，
 * 而不是每回合超时。探测只读 /health，不发隐私文本。
 */
export interface ServiceProbeOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ServiceProbeResult {
  reachable: boolean;
  systemone: boolean;
  embeddings: boolean;
  rerank: boolean;
  models: string[];
  error?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export async function probeService(opts: ServiceProbeOptions): Promise<ServiceProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  timer.unref?.();
  try {
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(joinUrl(opts.baseUrl, '/health'), {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, systemone: false, embeddings: false, rerank: false, models: [], error: `HTTP ${res.status}` };
    }
    const body = await res.json() as {
      services?: Array<{
        type?: string; id?: string; name?: string; tasks?: string[];
        entry?: { type?: string; id?: string; name?: string; tasks?: string[] };
      }>;
      models?: number | Array<string | { id?: string; name?: string }>;
    };
    const types = new Set((body.services ?? []).map((s) =>
      s.type ?? s.entry?.type ?? s.id ?? s.entry?.id ?? s.name ?? s.entry?.name ?? '',
    ).filter(Boolean));
    const tasks = new Set((body.services ?? []).flatMap((s) => [
      ...(Array.isArray(s.tasks) ? s.tasks : []),
      ...(Array.isArray(s.entry?.tasks) ? s.entry.tasks : []),
    ]).filter((task): task is string => typeof task === 'string' && task.trim() !== ''));
    const hasTasks = tasks.size > 0;
    // 服务 /health 的 models 是数量;有些实现会给数组。两种都接受。
    const rawModels = Array.isArray(body.models) ? body.models : [];
    const models = rawModels.map((m) => typeof m === 'string' ? m : m.id ?? m.name ?? '').filter(Boolean);
    return {
      reachable: true,
      // tasks 是模型级能力；没有 tasks 的旧服务回退到类型/模型名。
      systemone: tasks.has('systemone') || types.has('systemone'),
      embeddings: hasTasks
        ? tasks.has('embeddings')
        : types.has('llamacpp') || types.has('embedding') || models.some((m) => /embed|bge/i.test(m)),
      rerank: hasTasks
        ? tasks.has('rerank')
        : types.has('llamacpp') || types.has('rerank') || models.some((m) => /rerank/i.test(m)),
      models,
    };
  } catch (err) {
    return {
      reachable: false, systemone: false, embeddings: false, rerank: false, models: [],
      error: (err as Error)?.name === 'AbortError' ? 'timeout' : (err as Error)?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
