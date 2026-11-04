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
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** 选项 id 到一句判断标准的映射；至少 2 项。 */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** 等级 id 到含义的映射；2–10 级。 */
  legend: Record<string, string>;
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** 0..1，表示“是”的概率。 */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: string;
  confidence: number;
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
