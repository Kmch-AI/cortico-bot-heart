/**
 * 决策降级：SystemOne → 主模型（预留）→ 启发式。
 *
 * 0.1 先实现 SystemOne 与启发式；主模型回答同一组 typed questions 的路径需要 core.llm
 * 的 ResponseClient 适配，等 Core 暴露稳定的结构化输出接口后再接。这里保证任何失败都能继续。
 */
import type { Appraisal, RerankCandidate, RerankScore } from './types.ts';
import type { MemoryWriteDecision } from '../memory/types.ts';
import { SystemOneError, type SystemOneAnswer } from './types.ts';
import { SystemOneClient } from './systemone.ts';
import {
  appraiseQuestions,
  arbiterQuestions,
  memoryWriteQuestions,
  parseAppraisal,
  parseMemoryWriteDecision,
  parseRerank,
  rerankQuestions,
  turnPlanQuestions,
  turnPlanState,
} from './questions.ts';
import { heuristicTurnPlan, parseTurnPlan, type TurnPlan, type TurnPlanInput } from '../output/turnPlan.ts';
import type { MemoryCandidate, MemoryRecord } from '../memory/types.ts';

export interface DecisionTrace {
  task: string;
  at: string;
  mode: 'systemone' | 'heuristic' | 'skipped';
  latencyMs: number;
  error?: string;
  confidence?: number;
  summary?: string;
}

export interface DecisionPlaneOptions {
  client: SystemOneClient | null;
  /** 所有 SystemOne 请求共用的超时。 */
  timeoutMs: number;
  confidenceThreshold: number;
  onTrace?: (trace: DecisionTrace) => void;
  now?: () => number;
}

export interface TurnPlanDecision {
  plan: TurnPlan;
  trace: DecisionTrace;
}

export class DecisionPlane {
  constructor(private readonly opts: DecisionPlaneOptions) {}

  get available(): boolean {
    return this.opts.client !== null && !this.opts.client.circuitOpen;
  }

  async plan(input: TurnPlanInput, state: unknown): Promise<TurnPlanDecision> {
    const start = this.now();
    if (!this.opts.client) {
      const plan = heuristicTurnPlan(input);
      return { plan, trace: this.trace('turn_plan', 'heuristic', start, plan.confidence, 'no client') };
    }
    try {
      const response = await this.opts.client.ask({ state, questions: turnPlanQuestions(input) }, this.opts.timeoutMs, 1);
      const plan = parseTurnPlan(response.answers as Record<string, SystemOneAnswer>, input);
      // 低置信度的“回应”在非点名/非私聊场景回退为观察；不让一次模糊判断硬接话。
      if (plan.action === 'respond' && plan.confidence < this.opts.confidenceThreshold && !input.addressed && !input.isPrivate) {
        plan.action = 'silence';
        plan.reason += ' (low confidence -> silence)';
      }
      plan.needsArbiter = plan.needsArbiter || this.needsArbiter(plan, input);
      return { plan, trace: this.trace('turn_plan', 'systemone', start, plan.confidence, plan.reason) };
    } catch (err) {
      const plan = heuristicTurnPlan(input);
      const trace = this.trace('turn_plan', 'heuristic', start, plan.confidence, errorText(err));
      trace.error = errorText(err);
      return { plan, trace };
    }
  }

  async appraise(text: string, state: unknown): Promise<Appraisal | null> {
    if (!this.opts.client) return null;
    const start = this.now();
    try {
      const response = await this.opts.client.ask({ state: { text, ...(state as object) }, questions: appraiseQuestions() }, this.opts.timeoutMs, 1);
      const appraisal = parseAppraisal(response.answers as Record<string, SystemOneAnswer>);
      this.emit(this.trace('appraise', 'systemone', start, undefined, appraisal.reason));
      return appraisal;
    } catch (err) {
      this.emit(this.trace('appraise', 'skipped', start, undefined, errorText(err)));
      return null;
    }
  }

  async memoryWrite(
    candidate: MemoryCandidate,
    neighbors: readonly MemoryRecord[],
    capacity: { warm: number; hot: number },
  ): Promise<MemoryWriteDecision | null> {
    if (!this.opts.client) return null;
    const start = this.now();
    const { questions, targetIds } = memoryWriteQuestions(candidate, neighbors, capacity);
    try {
      const response = await this.opts.client.ask({
        state: {
          candidate: { kind: candidate.kind, title: candidate.title, content: candidate.content, scope: candidate.scope, sensitivity: candidate.sensitivity, evidence: candidate.evidence },
          neighbors: neighbors.slice(0, 8).map((r) => ({ id: r.id, title: r.title, kind: r.kind, updatedAt: r.stats.updatedAt, confidence: r.confidence })),
          capacity,
        },
        questions,
      }, this.opts.timeoutMs);
      const decision = parseMemoryWriteDecision(response.answers as Record<string, SystemOneAnswer>, targetIds);
      this.emit(this.trace('memory_write', 'systemone', start, decision.confidence, decision.reason));
      return decision;
    } catch (err) {
      this.emit(this.trace('memory_write', 'skipped', start, undefined, errorText(err)));
      return null;
    }
  }

  async rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankScore[] | null> {
    if (!this.opts.client || candidates.length === 0) return null;
    const start = this.now();
    const { questions, byQuestion } = rerankQuestions(candidates);
    try {
      const response = await this.opts.client.ask({ state: { query }, questions }, this.opts.timeoutMs);
      const scores = parseRerank(response.answers as Record<string, SystemOneAnswer>, byQuestion);
      this.emit(this.trace('memory_rerank', 'systemone', start, undefined, `${scores.length} scored`));
      return scores;
    } catch (err) {
      this.emit(this.trace('memory_rerank', 'skipped', start, undefined, errorText(err)));
      return null;
    }
  }

  async arbiter(query: string, candidates: readonly { id: string; text: string }[]): Promise<string | null> {
    if (!this.opts.client || candidates.length < 2) return null;
    const start = this.now();
    try {
      const response = await this.opts.client.ask({ state: { query }, questions: arbiterQuestions(candidates) }, this.opts.timeoutMs);
      const answer = response.answers.choice;
      const choice = answer?.type === 'choice' ? answer.choice : null;
      this.emit(this.trace('output_arbiter', 'systemone', start, answer?.type === 'choice' ? answer.confidence : undefined, choice ?? 'none'));
      return candidates.some((c) => c.id === choice) ? choice : null;
    } catch (err) {
      this.emit(this.trace('output_arbiter', 'skipped', start, undefined, errorText(err)));
      return null;
    }
  }

  private trace(task: string, mode: DecisionTrace['mode'], start: number, confidence?: number, summary?: string): DecisionTrace {
    return {
      task, at: new Date().toISOString(), mode,
      latencyMs: Math.max(0, this.now() - start),
      confidence, summary,
    };
  }

  private emit(trace: DecisionTrace): void {
    try { this.opts.onTrace?.(trace); } catch { /* trace 失败不影响决策 */ }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** 需要候选仲裁的回合：高 stakes，或低置信度的直接对话。 */
  private needsArbiter(plan: TurnPlan, input: TurnPlanInput): boolean {
    if (plan.action !== 'respond') return false;
    if (['challenge', 'refuse', 'correct'].includes(plan.intent)) return true;
    if (input.mood.tension > 0.65 || input.relationship.tension > 0.5) return true;
    return plan.confidence < this.opts.confidenceThreshold && (input.addressed || input.isPrivate);
  }
}

function errorText(err: unknown): string {
  if (err instanceof SystemOneError) return `${err.kind}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
