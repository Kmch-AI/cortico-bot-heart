/**
 * typed questions 的构造与答案映射。
 *
 * SystemOne 不生成文本；这里只把状态压成可判断的短材料，问 noul / choice / score。
 */
import type {
  Appraisal,
  RerankCandidate,
  RerankScore,
  SystemOneAnswer,
  SystemOneQuestion,
} from './types.ts';
import type { MemoryCandidate, MemoryRecord, MemoryWriteDecision } from '../memory/types.ts';
import type { TurnPlanInput } from '../output/turnPlan.ts';

const range = (n: number, label: (i: number) => string): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n + 1 }, (_, i) => [String(i), label(i)]));

export function turnPlanQuestions(): Record<string, SystemOneQuestion> {
  return {
    action: {
      type: 'choice',
      instructions: '这一批事件应该怎么处理？目标是选择这个人此刻想不想接话，不是最大化用户满意度。',
      criteria: {
        respond: '值得回应：被点名、私聊、直接提问、冲突、玩笑，或当前确实有话想说',
        silence: '看过但不回应：群聊闲聊、与自己无关、低能量或不想接',
        defer: '稍后再说：需要新信息，或现在不适合接，但不想永久忽略',
      },
    },
    addressed: { type: 'noul', instructions: '这句话是对我说的吗？包括被 @、引用、私聊、直接提问。' },
    voice: { type: 'noul', instructions: '这一句适合发语音吗？只判断发不发；发到哪里由来源决定。默认保守，群聊尤其如此。' },
    needs_arbiter: { type: 'noul', instructions: '这个回合说错代价高、立场微妙或表达难，值得先生成候选再选吗？' },
    intent: {
      type: 'choice',
      instructions: '这句话主要想做什么？',
      criteria: {
        acknowledge: '接住对方的话',
        agree: '表示认同',
        empathize: '回应情绪',
        tease: '调侃/玩笑',
        challenge: '质疑或反对',
        share: '分享自己的看法/经历',
        explain: '解释一件事',
        suggest: '给建议',
        avoid: '转移/回避',
        close: '收束话题',
        perform: '表演/逗乐',
        probe: '追问',
        correct: '纠正事实',
        refuse: '拒绝',
      },
    },
    stance: {
      type: 'choice',
      instructions: '我的立场是什么？不是对方希望我站哪边。',
      criteria: { agree: '认同', disagree: '不认同', neutral: '中立', unsure: '不确定', deflect: '不想表态' },
    },
    depth: {
      type: 'score',
      instructions: '这句话需要多少认知投入？不等于长度。',
      legend: range(4, (i) => ['自动反应', '浅层', '一般', '深度', '严谨推理'][i] ?? String(i)),
    },
    length: {
      type: 'choice',
      instructions: '期望长度。',
      criteria: { short: '一两句', medium: '一小段', long: '展开说' },
    },
    directness: {
      type: 'choice',
      instructions: '表达直接程度。',
      criteria: { indirect: '含蓄/留白', neutral: '正常', direct: '直接说' },
    },
    playfulness: {
      type: 'score',
      instructions: '玩笑/调侃强度。',
      legend: range(4, (i) => ['无', '很轻', '适中', '明显', '很强'][i] ?? String(i)),
    },
  };
}

export function turnPlanState(input: {
  eventSummary: string;
  recent: string;
  mood: unknown;
  relationship: unknown;
  hot: string[];
  delivery: string;
  input: TurnPlanInput;
}): unknown {
  return {
    events: input.eventSummary,
    recent: input.recent,
    mood: input.mood,
    relationship: input.relationship,
    hot: input.hot,
    delivery: input.delivery,
    flags: {
      addressed: input.input.addressed,
      private: input.input.isPrivate,
      mentioned: input.input.mentioned,
      voiceAvailable: input.input.voiceAvailable ?? false,
      explicitVoiceRequested: input.input.explicitVoiceRequested ?? false,
    },
  };
}

export function appraiseQuestions(): Record<string, SystemOneQuestion> {
  return {
    valence: {
      type: 'score',
      instructions: '这件事让我愉悦还是不悦？',
      legend: range(4, (i) => ['很不悦', '不悦', '中性', '愉悦', '很愉悦'][i] ?? String(i)),
    },
    arousal: { type: 'score', instructions: '激活/激动程度。', legend: range(4, (i) => ['很低', '低', '中', '高', '很高'][i] ?? String(i)) },
    energy: { type: 'score', instructions: '社交/认知能量变化。', legend: range(4, (i) => ['耗尽', '低', '中', '高', '充沛'][i] ?? String(i)) },
    tension: { type: 'score', instructions: '紧张/防备程度。', legend: range(4, (i) => ['放松', '轻', '中', '紧', '很紧'][i] ?? String(i)) },
    importance: { type: 'score', instructions: '这件事对关系/目标有多重要？', legend: range(4, (i) => ['无关', '轻', '中', '重要', '很重要'][i] ?? String(i)) },
    relationship_delta: {
      type: 'score',
      instructions: '这件事让关系变近还是变远？',
      legend: range(4, (i) => ['明显变远', '略远', '不变', '略近', '明显变近'][i] ?? String(i)),
    },
  };
}

export function memoryWriteQuestions(
  candidate: MemoryCandidate,
  neighbors: readonly MemoryRecord[],
  capacity: { warm: number; hot: number },
): { questions: Record<string, SystemOneQuestion>; targetIds: string[] } {
  const targetIds = neighbors.slice(0, 8).map((r) => r.id);
  const targetCriteria: Record<string, string> = Object.fromEntries(neighbors.slice(0, 8).map((r) => [r.id, `${r.title}（${r.kind}，${r.stats.updatedAt.slice(0, 10)}）`]));
  if (targetIds.length < 2) {
    targetCriteria.none = '没有可合并的邻居，作为新记录';
    targetCriteria.create = '明确新建';
  }
  return {
    targetIds,
    questions: {
      save: { type: 'noul', instructions: `这条候选值得长期保存吗？当前 warm=${capacity.warm}/hot=${capacity.hot}。只保存耐久的偏好、关系、事实、承诺、重要事件或身份信息。` },
      op: {
        type: 'choice',
        instructions: '如果保存，应该怎么处理？',
        criteria: {
          create: '新记录',
          update: '更新已有记录',
          merge: '与邻居合并',
          skip: '不保存',
          defer: '先留着，等更多证据',
        },
      },
      target: {
        type: 'choice',
        instructions: '要更新/合并到哪条邻居？没有就选 none/create。',
        criteria: targetCriteria,
      },
      confidence: { type: 'score', instructions: '候选的可信度。', legend: range(4, (i) => ['猜测', '弱', '中', '强', '确证'][i] ?? String(i)) },
      salience: { type: 'score', instructions: '这条记忆有多重要？', legend: range(4, (i) => ['可忘', '低', '中', '高', '核心'][i] ?? String(i)) },
    },
  };
}

export function parseAppraisal(answers: Record<string, SystemOneAnswer>): Appraisal {
  const score = (id: string, fallback: number): number => {
    const a = answers[id];
    if (!a || a.type !== 'score') return fallback;
    const values = Object.keys(a.legend ?? {});
    const index = values.indexOf(String(a.score));
    return index >= 0 ? index / Math.max(1, values.length - 1) : fallback;
  };
  return {
    valence: score('valence', 0.5) * 2 - 1,
    arousal: score('arousal', 0.5),
    energy: score('energy', 0.5),
    tension: score('tension', 0.3),
    importance: score('importance', 0.4),
    relationshipDelta: score('relationship_delta', 0.5) * 2 - 1,
    reason: `systemone appraisal: valence=${score('valence', 0.5).toFixed(2)}, importance=${score('importance', 0.4).toFixed(2)}`,
  };
}

export function parseMemoryWriteDecision(
  answers: Record<string, SystemOneAnswer>,
  targetIds: readonly string[],
): MemoryWriteDecision {
  const noul = answers.save;
  const save = noul?.type === 'noul' ? noul.noul >= 0.5 : false;
  const opAnswer = answers.op;
  const opRaw = opAnswer?.type === 'choice' ? opAnswer.choice : save ? 'create' : 'skip';
  const op = (['create', 'update', 'merge', 'skip', 'defer'] as const).includes(opRaw as never)
    ? opRaw as MemoryWriteDecision['op'] : 'skip';
  const targetAnswer = answers.target;
  const target = targetAnswer?.type === 'choice' ? targetAnswer.choice : '';
  const confidence = scoreValue(answers.confidence, 0.6);
  const salience = scoreValue(answers.salience, 0.5);
  return {
    save,
    op: save ? op : 'skip',
    targetIds: targetIds.includes(target) ? [target] : [],
    confidence,
    salience,
    reason: `save=${save} op=${op} target=${target || 'none'}`,
  };
}

function scoreValue(answer: SystemOneAnswer | undefined, fallback: number): number {
  if (!answer || answer.type !== 'score') return fallback;
  const values = Object.keys(answer.legend ?? {});
  const index = values.indexOf(String(answer.score));
  return index >= 0 ? index / Math.max(1, values.length - 1) : fallback;
}

export function rerankQuestions(candidates: readonly RerankCandidate[]): { questions: Record<string, SystemOneQuestion>; byQuestion: Map<string, string> } {
  const questions: Record<string, SystemOneQuestion> = {};
  const byQuestion = new Map<string, string>();
  for (const [i, candidate] of candidates.slice(0, 40).entries()) {
    const id = `c${i}`;
    questions[id] = { type: 'noul', instructions: `这条记忆与当前回合相关且值得注入吗？${candidate.text.slice(0, 240)}` };
    byQuestion.set(id, candidate.id);
  }
  return { questions, byQuestion };
}

export function parseRerank(answers: Record<string, SystemOneAnswer>, byQuestion: Map<string, string>): RerankScore[] {
  const out: RerankScore[] = [];
  for (const [qid, recordId] of byQuestion) {
    const a = answers[qid];
    if (a?.type === 'noul') out.push({ id: recordId, score: a.noul });
  }
  return out;
}

export function arbiterQuestions(candidates: readonly { id: string; text: string }[]): Record<string, SystemOneQuestion> {
  const criteria = Object.fromEntries(candidates.map((c) => [c.id, c.text.slice(0, 300)]));
  return {
    choice: {
      type: 'choice',
      instructions: '哪一句最像这个人此刻真想说的话？按自洽、立场、关系、事实、风险、清晰度判断；不要按用户满意度判断。',
      criteria,
    },
  };
}
