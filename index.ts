/** 默认导出 BotDefinition；deployment.json 的 bot 字段引用包名。 */
import { resolve } from 'node:path';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { CoreConfig, World } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/core/config.ts';
import { describeTools, type WorldDeclaration } from 'cortico/world.ts';
import { HEART_DEFAULTS, heartConfigGroups, type HeartConfig } from './config.ts';
import { HeartPersona, endTurnTool } from './persona/persona.ts';
import { memoryToolDecls } from './memory/tools.ts';

const HERE = resolve(import.meta.dirname);

export interface HeartBotConfig extends HeartConfig {}

/** 默认声明：控制台、QQ、语音、服务。未安装的 World 显示不可用，不影响 bot 启动。 */
const DECLARES: readonly WorldDeclaration[] = ['console', 'qq', 'voice', 'service'];

function build(loaded: LoadedConfig<HeartBotConfig>, worlds: World[]): BotParts<HeartBotConfig> {
  const persona = new HeartPersona({
    memoryDir: loaded.memoryDir,
    packageDir: HERE,
    worlds,
    config: () => loaded.config,
    secret: (name) => loaded.secret(name),
    logger: {
      warn: (msg, data) => console.warn(`[heart] ${msg}`, data ?? ''),
      info: (msg, data) => console.info(`[heart] ${msg}`, data ?? ''),
    },
  });
  return {
    persona,
    onStop: () => persona.shutdown(),
    webUi: {
      configGroups: heartConfigGroups(),
      status: () => ({
        memory: persona.store.stats(),
        backend: persona.store.backend,
        worker: { pending: persona.worker.pending, busy: persona.worker.busy },
      }),
    },
  };
}

const definition: BotDefinition<HeartBotConfig> = {
  id: 'heart',
  memoryName: 'Memory',
  declares: DECLARES,
  defaults: () => structuredClone(HEART_DEFAULTS) as HeartBotConfig,
  build,
  describe: {
    tools: describeTools(
      [...memoryToolDecls(), {
        name: endTurnTool().name,
        description: endTurnTool().description,
        tags: endTurnTool().tags,
        parameters: endTurnTool().parameters,
      }],
      {
        memory_search: { zh: '检索长期记忆，返回紧凑卡片。', en: 'Search long-term memory and return compact cards.' },
        memory_read: { zh: '读取一条记忆的正文与证据。', en: 'Read one memory with its evidence.' },
        memory_note: { zh: '提议保存一条记忆；走保存决策，不直接写入。', en: 'Propose a durable memory; it goes through the save decision.' },
        memory_pin: { zh: '调整记忆的冷热层级。', en: 'Raise or lower a memory tier.' },
        memory_forget: { zh: '请求忘记一条记忆，默认需要操作者确认。', en: 'Request forgetting a memory; operator confirmation is required by default.' },
        end_turn: { zh: '结束这一轮，等新事件再醒。', en: 'End the turn until new events arrive.' },
      },
    ),
    memory: {
      form: {
        zh: 'SQLite（node:sqlite + 可选 sqlite-vec）为运行真源；JSONL 只做审计/导出；Memory 页可检索、读取、分层与删除。',
        en: 'SQLite (node:sqlite + optional sqlite-vec) is the runtime source of truth; JSONL is audit/export only; the Memory page can search, read, tier and delete.',
      },
    },
  },
};

export default definition;
