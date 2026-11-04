/**
 * 直连 `core.llm` 的后台工具循环。
 *
 * 不经过 `spawnFork`，因此不会在 SessionTracker 里登记临时 session，控制台不会为每次
 * 记忆提取多出一个对话窗口；也不需要 Core 增加 hidden fork 能力。代价是这里的调用不出现在
 * session/用量表里，只在决策 trace 里记耗时与结果。
 *
 * 循环形状与 Core 的 fork 保持一致：请求 → 执行工具 → 回执 → 下一轮；工具结果与失败标记
 * 复用 Core 的 markers，避免模型看到不同的措辞。
 */
import type { Logger, ModelSpec, ToolCallContext, ToolDef } from 'cortico/core/types.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import {
  NOT_EXECUTED_BARRIER,
  NOT_EXECUTED_INCOMPLETE,
  NOT_EXECUTED_THREAD_ENDED,
  forkUnknownTool,
  toolFailed,
} from 'cortico/core/markers.ts';
import {
  functionResult,
  responseRecords,
  type ContextRecord,
} from 'cortico/protocol/open-responses/context.ts';
import { responseRequest, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';

export interface DirectWorkerOptions {
  llm: ResponseClient;
  spec: ModelSpec;
  messages: readonly ContextRecord[];
  tools?: readonly ToolDef[];
  log: Logger;
  role?: string;
  maxRounds?: number;
  signal?: AbortSignal;
  stopWhen?: () => boolean;
}

export interface DirectWorkerResult {
  text: string;
  rounds: number;
}

export async function runDirectWorker(opts: DirectWorkerOptions): Promise<DirectWorkerResult> {
  const llm = opts.llm.bind?.() ?? opts.llm;
  const tools = opts.tools ?? [];
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages = [...opts.messages];
  const role = opts.role ?? 'memory';
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
  let text = '';

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.signal?.aborted) return { text, rounds: round - 1 };
    const generated = await llm.respond(responseRequest(opts.spec, messages, schemas), {
      role,
      context: messages,
      nativeSpec: opts.spec,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const output = responseRecords(generated.response, generated.origin);
    messages.push(...output);
    const roundText = output
      .filter((entry) => entry.item.type === 'message')
      .map((entry) => textOf(entry))
      .join('');
    if (roundText) text = roundText;

    const calls = generated.response.output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) return { text, rounds: round };
    let barrier = false;
    for (const call of calls) {
      let out: string;
      let ended = false;
      const def = tools.find((tool) => tool.name === call.name);
      if (opts.signal?.aborted) out = NOT_EXECUTED_THREAD_ENDED;
      else if (barrier) out = NOT_EXECUTED_BARRIER;
      else if (call.status !== 'completed') {
        out = NOT_EXECUTED_INCOMPLETE;
        barrier = true;
      } else if (!def) out = forkUnknownTool(call.name);
      else {
        try {
          const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          const result = await def.handler(args, {
            role,
            log: opts.log,
            callId: call.call_id,
            round,
          } as ToolCallContext);
          out = typeof result === 'string' ? result : result.text;
          ended = def.endsTurn === true;
        } catch (error) {
          out = toolFailed(error instanceof Error ? error.message : String(error));
        }
        if (def.barrierAfter) barrier = true;
      }
      messages.push(functionResult(call.call_id, out));
      if (ended || opts.stopWhen?.()) return { text, rounds: round };
    }
  }
  return { text, rounds: maxRounds };
}

/** 无工具的纯文本生成；arbiter 用。 */
export async function runDirectText(opts: Omit<DirectWorkerOptions, 'tools' | 'stopWhen'>): Promise<string> {
  const result = await runDirectWorker({ ...opts, tools: [], maxRounds: 1 });
  return result.text;
}
