import type { ConfigGroup, CoreConfig } from 'cortico/core/types.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';

/** heart 的全部部署配置；CoreConfig 之外的段归 Persona。 */
export interface HeartConfig extends CoreConfig {
  rounds: { soft: number; hard: number };
  identity: {
    displayName: string;
    language: 'zh' | 'en';
    /** 空串沿用 Core 的 timezone。 */
    timezone: string;
  };
  decision: {
    enabled: boolean;
    serviceUrl: string;
    /** 只存 secret 名；值从部署 .env 读。 */
    tokenSecret: string;
    systemoneModel: string;
    /** 后台决策（记忆写入、重排、arbiter）的超时。 */
    timeoutMs: number;
    /** 对话热路径（turn_plan / appraise）的等待预算；超时立即启发式，不重试。 */
    interactiveTimeoutMs: number;
    /** SystemOne 不可用时是否让主模型回答同一组 typed questions。 */
    fallbackToMain: boolean;
    /** 低于此 confidence 的 choice 走保守回退。 */
    confidenceThreshold: number;
  };
  vectors: {
    enabled: boolean;
    serviceUrl: string;
    tokenSecret: string;
    embeddingModel: string;
    rerankModel: string;
    /** 库内一旦写入就固定；变化需要重建向量索引。 */
    dim: number;
    batch: number;
    timeoutMs: number;
  };
  memory: {
    backend: 'auto' | 'sqlite' | 'jsonl';
    hotTokenBudget: number;
    warmLimit: number;
    /** 写入后是否后台补 embedding。 */
    autoEmbedding: boolean;
  };
  retrieval: {
    topK: number;
    rerankTopN: number;
    mmrLambda: number;
    tokenBudget: number;
    abstainThreshold: number;
  };
  worker: {
    queueLimit: number;
    timeoutMs: number;
    consolidation: boolean;
  };
  mood: {
    inertia: number;
    halfLifeMinutes: number;
    baseline: {
      valence: number;
      arousal: number;
      energy: number;
      tension: number;
      openness: number;
      patience: number;
      playfulness: number;
      focus: number;
    };
  };
  voice: {
    enabled: boolean;
    /** 群聊默认不发；明确要求/高情绪仍可由决策层打开。 */
    groupDefault: boolean;
    maxPerTurns: number;
    explicitKeywords: string[];
  };
  output: {
    mode: 'auto' | 'plan' | 'arbiter';
    candidates: number;
    timeoutMs: number;
  };
  consolidation: {
    idleMinutes: number;
    everyTurns: number;
    identityThreshold: number;
  };
  observability: {
    traceDays: number;
    metrics: boolean;
  };
}

export const HEART_DEFAULTS: HeartConfig = {
  ...structuredClone(CORE_DEFAULTS) as unknown as CoreConfig,
  rounds: { soft: 6, hard: 12 },
  identity: {
    displayName: 'Kmch AI · 心',
    language: 'zh',
    timezone: '',
  },
  decision: {
    enabled: true,
    serviceUrl: 'http://127.0.0.1:9883',
    tokenSecret: 'CORTICO_SERVICE_TOKEN',
    systemoneModel: 'jev-latest',
    timeoutMs: 2000,
    interactiveTimeoutMs: 1200,
    fallbackToMain: true,
    confidenceThreshold: 0.55,
  },
  vectors: {
    enabled: true,
    serviceUrl: 'http://127.0.0.1:9883',
    tokenSecret: 'CORTICO_SERVICE_TOKEN',
    embeddingModel: 'bge-m3',
    rerankModel: 'bge-reranker',
    dim: 768,
    batch: 64,
    timeoutMs: 3000,
  },
  memory: {
    backend: 'auto',
    hotTokenBudget: 900,
    warmLimit: 5000,
    autoEmbedding: true,
  },
  retrieval: {
    topK: 8,
    rerankTopN: 20,
    mmrLambda: 0.7,
    tokenBudget: 1000,
    abstainThreshold: 0.35,
  },
  worker: {
    queueLimit: 16,
    timeoutMs: 120000,
    consolidation: true,
  },
  mood: {
    inertia: 0.85,
    halfLifeMinutes: 60,
    baseline: {
      valence: 0.05,
      arousal: 0.35,
      energy: 0.55,
      tension: 0.15,
      openness: 0.6,
      patience: 0.55,
      playfulness: 0.35,
      focus: 0.5,
    },
  },
  voice: {
    enabled: true,
    groupDefault: false,
    maxPerTurns: 3,
    explicitKeywords: ['语音', '发语音', '念出来', '读出来', 'voice'],
  },
  output: {
    mode: 'auto',
    candidates: 2,
    timeoutMs: 3000,
  },
  consolidation: {
    idleMinutes: 30,
    everyTurns: 50,
    identityThreshold: 0.85,
  },
  observability: {
    traceDays: 30,
    metrics: true,
  },
};

const prop = (
  title: string,
  description: string,
  type: 'integer' | 'number' | 'boolean' | 'string',
  extra: Record<string, unknown> = {},
): ConfigGroup['schema']['properties'][string] => ({ title, description, type, ...extra }) as never;

/** Persona 页的设置页签；值仍由 Core 的配置读写落到部署 config.json。 */
export function heartConfigGroups(): ConfigGroup[] {
  return [
    {
      id: 'heart-identity',
      owner: 'persona',
      schema: {
        type: 'object',
        title: '身份与轮数',
        properties: {
          'identity.displayName': prop('显示名', '写进提示词与关系卡的名字。', 'string'),
          'identity.language': prop('语言', '提示词与默认文案语言。', 'string', { enum: ['zh', 'en'] }),
          'identity.timezone': prop('时区', '留空沿用 Core 的 timezone。', 'string'),
          'rounds.soft': prop('软轮数', '提示收尾的轮次。', 'integer', { minimum: 1, maximum: 50 }),
          'rounds.hard': prop('硬轮数', '一批最多跑几轮。', 'integer', { minimum: 1, maximum: 100 }),
        },
      },
    },
    {
      id: 'heart-decision',
      owner: 'persona',
      schema: {
        type: 'object',
        title: '决策',
        properties: {
          'decision.enabled': prop('启用 SystemOne', '关闭后用启发式决策。', 'boolean'),
          'decision.serviceUrl': prop('服务地址', '服务 World 的 /v1/systemone 端点。', 'string'),
          'decision.tokenSecret': prop('令牌密钥名', '只存 .env 中的变量名。', 'string'),
          'decision.systemoneModel': prop('决策模型', 'Jev 兼容模型 id。', 'string'),
          'decision.timeoutMs': prop('后台超时', '记忆写入/重排/arbiter 的毫秒上限。', 'integer', { minimum: 200, maximum: 60000 }),
          'decision.interactiveTimeoutMs': prop('对话超时', 'turn_plan/appraise 的等待预算；超时立即启发式，不重试。', 'integer', { minimum: 100, maximum: 15000 }),
          'decision.confidenceThreshold': prop('置信度阈值', 'choice 低于此值时保守回退。', 'number', { minimum: 0, maximum: 1 }),
        },
      },
    },
    {
      id: 'heart-memory',
      owner: 'persona',
      schema: {
        type: 'object',
        title: '记忆',
        properties: {
          'memory.backend': prop('存储后端', 'auto 优先 SQLite。', 'string', { enum: ['auto', 'sqlite', 'jsonl'] }),
          'memory.hotTokenBudget': prop('hot 预算', '常驻前缀的 token 上限。', 'integer', { minimum: 200, maximum: 4000 }),
          'memory.warmLimit': prop('warm 上限', '主检索池的记录数上限。', 'integer', { minimum: 100, maximum: 50000 }),
          'memory.autoEmbedding': prop('自动 embedding', '写入后后台补向量。', 'boolean'),
          'worker.queueLimit': prop('队列上限', '满时丢弃最低优先级包。', 'integer', { minimum: 1, maximum: 100 }),
          'worker.timeoutMs': prop('后台超时', '单包提取的毫秒上限。', 'integer', { minimum: 5000, maximum: 600000 }),
          'worker.consolidation': prop('后台巩固', '空闲时整理与分层。', 'boolean'),
          'consolidation.idleMinutes': prop('巩固间隔', '空闲多少分钟后整理。', 'integer', { minimum: 1, maximum: 1440 }),
        },
      },
    },
    {
      id: 'heart-retrieval',
      owner: 'persona',
      schema: {
        type: 'object',
        title: '检索与向量',
        properties: {
          'retrieval.topK': prop('召回条数', '每回合注入的最大卡片数。', 'integer', { minimum: 1, maximum: 30 }),
          'retrieval.rerankTopN': prop('重排候选', '送 rerank 的候选数。', 'integer', { minimum: 1, maximum: 100 }),
          'retrieval.tokenBudget': prop('检索预算', '每回合记忆卡片 token 上限。', 'integer', { minimum: 200, maximum: 4000 }),
          'retrieval.mmrLambda': prop('MMR 多样性', '0 更重相关性，1 更重多样性。', 'number', { minimum: 0, maximum: 1 }),
          'retrieval.abstainThreshold': prop('弃权阈值', '低于此分数不注入卡片。', 'number', { minimum: 0, maximum: 1 }),
          'vectors.enabled': prop('启用向量', '需要 embeddings / rerank 服务。', 'boolean'),
          'vectors.serviceUrl': prop('向量服务地址', '服务 World 的 /v1 根地址。', 'string'),
          'vectors.tokenSecret': prop('令牌密钥名', '只存 .env 中的变量名。', 'string'),
          'vectors.embeddingModel': prop('Embedding 模型', '如 bge-m3。', 'string'),
          'vectors.rerankModel': prop('Rerank 模型', '如 bge-reranker。', 'string'),
          'vectors.dim': prop('向量维度', '变更后需要重建索引。', 'integer', { minimum: 8, maximum: 4096 }),
          'vectors.batch': prop('批大小', '一次 embedding 的条数。', 'integer', { minimum: 1, maximum: 512 }),
          'vectors.timeoutMs': prop('向量超时', '毫秒。', 'integer', { minimum: 500, maximum: 60000 }),
        },
      },
    },
    {
      id: 'heart-output',
      owner: 'persona',
      schema: {
        type: 'object',
        title: '输出与语音',
        properties: {
          'output.mode': prop('输出模式', 'auto 只在需要时生成候选。', 'string', { enum: ['auto', 'plan', 'arbiter'] }),
          'output.candidates': prop('候选数', 'arbiter 生成几句候选。', 'integer', { minimum: 2, maximum: 5 }),
          'output.timeoutMs': prop('候选超时', '毫秒。', 'integer', { minimum: 500, maximum: 30000 }),
          'voice.enabled': prop('允许语音', '关掉后一切语音决策为否。', 'boolean'),
          'voice.groupDefault': prop('群聊默认语音', '默认关闭，避免刷屏。', 'boolean'),
          'voice.maxPerTurns': prop('语音上限', '每 N 轮最多一次。', 'integer', { minimum: 1, maximum: 20 }),
          'mood.inertia': prop('情绪惯性', '0 立即回落，1 几乎不衰减。', 'number', { minimum: 0, maximum: 1 }),
          'mood.halfLifeMinutes': prop('情绪半衰期', '分钟。', 'integer', { minimum: 5, maximum: 1440 }),
        },
      },
    },
  ];
}
