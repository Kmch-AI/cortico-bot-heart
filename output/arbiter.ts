/**
 * 可选输出仲裁：先生成 2–3 个候选，再由 SystemOne 选。
 *
 * 只用于说错代价高、立场微妙或表达难的回合；候选生成在 fork 里做纯文本，不执行工具，
 * 避免重复发送或绕过 QQ 确认门。
 */
import type { HeartConfig } from '../config.ts';
import type { TurnPlan } from './turnPlan.ts';

export interface ArbiterCandidate {
  id: string;
  text: string;
}

export function shouldArbitrate(mode: HeartConfig['output']['mode'], plan: TurnPlan): boolean {
  if (mode === 'plan') return false;
  if (mode === 'arbiter') return true;
  return plan.needsArbiter;
}

export function buildCandidateBrief(input: {
  stateCard: string;
  planText: string;
  deliveryText: string;
  count: number;
}): string {
  return [
    '你在为一个 bot 生成候选回复，只输出纯文本，不调用工具。',
    '先问「这个人此刻想说什么」，不要按用户满意度选立场；候选之间要有真实的取舍差异，不是同义改写。',
    '不要写 Markdown 代码块，不要写解释，不要写编号。用一行 `---` 分隔候选。',
    `生成 ${input.count} 个候选。`,
    '',
    input.stateCard,
    input.planText,
    input.deliveryText,
  ].join('\n');
}

export function parseCandidates(text: string, max = 3): ArbiterCandidate[] {
  return text
    .split(/\n\s*---\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, max)
    .map((part, i) => ({ id: `candidate_${i + 1}`, text: part.slice(0, 4000) }));
}

export function fallbackChoice(candidates: readonly ArbiterCandidate[]): ArbiterCandidate | null {
  return candidates[0] ?? null;
}
