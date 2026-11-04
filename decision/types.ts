/**
 * SystemOne / TypeSafe Jev 的类型化决策契约。
 *
 * 这里只有 wire format 与答案形状；不生成自由文本。turn plan、记忆正文、查询串等生成任务
 * 由主模型或后台 fork 完成。
 */

export type SystemOneQuestionType = 'noul' | 'choice' | 'score';

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  /** 可选：true/false 两个选项的补充说明。 */
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** 选项 id 到一句判断标准的映射；2–26 项。 */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** 等级描述，最低级在前；2–10 级。Jev 的 score 用 criteria 数组，不是 legend 映射。 */
  criteria: string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** 0..1，表示“是”的概率。 */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** allow_none 生效时可能为 null，表示弃权。 */
  choice: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  /** allow_none 的额外选项概率；普通选项概率已重新归一。 */
  none_probability?: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** 按等级概率加权的期望值，0..n-1；不是等级 id 字符串。 */
  score: number;
  confidence: number;
  /** 等级 id（"0".."n-1"）到描述的映射。 */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  model: string;
  /** string / object / array；最大 65,536 tokens，服务端不静默截断。 */
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SystemOneClientOptions {
  baseUrl: string;
  token?: string;
  model: string;
  timeoutMs: number;
  /** 连续失败后熔断的时长。 */
  circuitCooldownMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export type SystemOneFailureKind =
  | 'disabled'
  | 'not-configured'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response'
  | 'circuit-open';

export class SystemOneError extends Error {
  constructor(
    readonly kind: SystemOneFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SystemOneError';
  }
}

export interface Appraisal {
  valence: number;
  arousal: number;
  energy: number;
  tension: number;
  importance: number;
  relationshipDelta: number;
  reason: string;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankScore {
  id: string;
  score: number;
}
