/**
 * 回合计划：决策层给主模型的约束，不是剧本。
 * 只含类型化字段；自由文本（我想说什么、语音 instruct、查询串）由主模型或后台 fork 生成。
 */
import type { SystemOneAnswer } from '../decision/types.ts';

export type TurnAction = 'respond' | 'silence' | 'defer';

export type CommunicativeIntent =
  | 'acknowledge' | 'agree' | 'empathize' | 'tease' | 'challenge' | 'share'
  | 'explain' | 'suggest' | 'avoid' | 'close' | 'perform' | 'probe' | 'correct' | 'refuse';

export type Stance = 'agree' | 'disagree' | 'neutral' | 'unsure' | 'deflect';
export type CognitiveDepth = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type ExpectedLength = 'short' | 'medium' | 'long';
export type Directness = 'indirect' | 'neutral' | 'direct';

export interface TurnPlan {
  action: TurnAction;
  confidence: number;
  addressed: boolean;
  topicRelevance: number;
  moodFit: number;
  reason: string;
  intent: CommunicativeIntent;
  stance: Stance;
  cognitiveDepth: CognitiveDepth;
  length: ExpectedLength;
  directness: Directness;
  playfulness: number;
  voice: boolean;
  needsArbiter: boolean;
}

export interface TurnPlanInput {
  text: string;
  source: string;
  addressed: boolean;
  isPrivate: boolean;
  mentioned: boolean;
  mood: { valence: number; energy: number; tension: number; playfulness: number; openness: number; patience: number; label: string };
  relationship: { familiarity: number; trust: number; intimacy: number; tension: number; status: string };
  recentAssistantCount?: number;
  voiceAvailable?: boolean;
  explicitVoiceRequested?: boolean;
  /** 用户明确要求记住某事；这类回合至少应该回一句。 */
  explicitMemoryRequested?: boolean;
}

const INTENTS: readonly CommunicativeIntent[] = [
  'acknowledge', 'agree', 'empathize', 'tease', 'challenge', 'share',
  'explain', 'suggest', 'avoid', 'close', 'perform', 'probe', 'correct', 'refuse',
];
const STANCES: readonly Stance[] = ['agree', 'disagree', 'neutral', 'unsure', 'deflect'];
const LENGTHS: readonly ExpectedLength[] = ['short', 'medium', 'long'];
const DIRECTNESS: readonly Directness[] = ['indirect', 'neutral', 'direct'];

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function choiceOf(answer: SystemOneAnswer | undefined, fallback: string): string {
  if (!answer || answer.type !== 'choice') return fallback;
  return answer.choice || fallback;
}

function noulOf(answer: SystemOneAnswer | undefined, fallback: boolean): boolean {
  if (!answer || answer.type !== 'noul') return fallback;
  return answer.noul >= 0.5;
}

/** score 是 0..levels 的期望等级值，直接使用；不要再拿 legend 的键反查。 */
function scoreOf(answer: SystemOneAnswer | undefined, fallback: number, levels: number): number {
  if (!answer || answer.type !== 'score') return fallback;
  const n = typeof answer.score === 'number' ? answer.score : Number(answer.score);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(levels, n));
}

export function heuristicTurnPlan(input: TurnPlanInput): TurnPlan {
  const direct = input.addressed || input.mentioned || input.isPrivate || input.explicitMemoryRequested === true;
  const question = /[?？]|吗|呢|怎么|为什么|如何|帮我|请问/.test(input.text);
  const tired = input.mood.energy < 0.3;
  const tense = input.mood.tension > 0.65;
  const lowPatience = input.mood.patience < 0.3;
  const action: TurnAction = direct || question ? 'respond' : (input.relationship.familiarity > 0.45 && input.mood.energy > 0.45 ? 'respond' : 'silence');
  const confidence = direct ? 0.72 : action === 'respond' ? 0.55 : 0.58;
  const intent: CommunicativeIntent = question ? 'acknowledge' : input.mood.playfulness > 0.55 ? 'tease' : 'share';
  const stance: Stance = tense || lowPatience ? 'deflect' : 'neutral';
  const depth: CognitiveDepth = question ? (tired ? 'L1' : 'L2') : (tired ? 'L0' : 'L1');
  const length: ExpectedLength = tired || tense ? 'short' : question ? 'medium' : 'short';
  return {
    action,
    confidence,
    addressed: input.addressed,
    topicRelevance: question ? 0.7 : input.relationship.familiarity * 0.5,
    moodFit: clamp01(0.5 + input.mood.valence * 0.2 + input.mood.energy * 0.2),
    reason: `heuristic: ${direct ? 'direct/private' : 'ambient'}, energy=${input.mood.energy.toFixed(2)}, question=${question}`,
    intent,
    stance,
    cognitiveDepth: depth,
    length,
    directness: direct ? 'neutral' : 'indirect',
    playfulness: clamp01(input.mood.playfulness * (tense ? 0.4 : 1)),
    voice: false,
    needsArbiter: false,
  };
}

/** 把 SystemOne answers 映射成 TurnPlan；缺项用启发式补齐，不硬造高置信。 */
export function parseTurnPlan(answers: Record<string, SystemOneAnswer>, input: TurnPlanInput): TurnPlan {
  const fallback = heuristicTurnPlan(input);
  const actionRaw = choiceOf(answers.action, fallback.action);
  const action: TurnAction = actionRaw === 'respond' || actionRaw === 'silence' || actionRaw === 'defer' ? actionRaw : fallback.action;
  const confidence = clamp01(Number((answers.action as { confidence?: number } | undefined)?.confidence ?? fallback.confidence));
  const intentRaw = choiceOf(answers.intent, fallback.intent) as CommunicativeIntent;
  const stanceRaw = choiceOf(answers.stance, fallback.stance) as Stance;
  const lengthRaw = choiceOf(answers.length, fallback.length) as ExpectedLength;
  const directnessRaw = choiceOf(answers.directness, fallback.directness) as Directness;
  const depthRaw = scoreOf(answers.depth, Number(fallback.cognitiveDepth.slice(1)), 4);
  const playfulness = scoreOf(answers.playfulness, fallback.playfulness * 4, 4) / 4;
  return {
    action,
    confidence,
    addressed: noulOf(answers.addressed, fallback.addressed),
    topicRelevance: clamp01(Number((answers.action as { probabilities?: Record<string, number> } | undefined)?.probabilities?.[action] ?? fallback.topicRelevance)),
    moodFit: fallback.moodFit,
    reason: [
      `action=${actionRaw}`,
      `addressed=${noulOf(answers.addressed, fallback.addressed)}`,
      `voice=${noulOf(answers.voice, false)}`,
      `confidence=${confidence.toFixed(2)}`,
    ].join(' '),
    intent: INTENTS.includes(intentRaw) ? intentRaw : fallback.intent,
    stance: STANCES.includes(stanceRaw) ? stanceRaw : fallback.stance,
    cognitiveDepth: `L${Math.max(0, Math.min(4, Math.round(depthRaw)))}` as CognitiveDepth,
    length: LENGTHS.includes(lengthRaw) ? lengthRaw : fallback.length,
    directness: DIRECTNESS.includes(directnessRaw) ? directnessRaw : fallback.directness,
    playfulness: clamp01(playfulness),
    voice: noulOf(answers.voice, false),
    needsArbiter: noulOf(answers.needs_arbiter, false),
  };
}

/** 动态头里的紧凑版本；只给约束，不给台词。 */
export function renderTurnPlan(plan: TurnPlan, delivery: string): string {
  const action = plan.action === 'respond' ? '回应' : plan.action === 'silence' ? '保持沉默' : '稍后/观察';
  return [
    `[turn plan] ${action}；意图 ${plan.intent}；立场 ${plan.stance}；深度 ${plan.cognitiveDepth}；长度 ${plan.length}；直接度 ${plan.directness}；玩心 ${Math.round(plan.playfulness * 100)}%；语音 ${plan.voice ? '要发' : '不发'}`,
    `[delivery] ${delivery}`,
    plan.action === 'silence'
      ? '这一批不值得回应：不要输出正文，不要调用发送工具，直接 end_turn。'
      : '先说你想说的，再考虑怎么说；不要为了取悦对方改变立场。可以短、可以不同意、可以拒绝。',
    plan.voice
      ? '语音只决定发不发；发到哪里按 delivery 的来源路由。语音文本只放要念的正文。'
      : '不要发语音；文字仍按 delivery 的来源路由。',
  ].join('\n');
}
