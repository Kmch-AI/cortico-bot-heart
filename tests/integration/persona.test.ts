import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreApi, EventEnvelope, ToolDef, World } from 'cortico/core/types.ts';
import type { SessionInfo } from 'cortico/core/types.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import { HeartPersona, isExplicitMemoryRequest } from '../../persona/persona.ts';
import { testConfig, tempDir } from '../helpers.ts';

const PACKAGE_DIR = resolve(import.meta.dirname, '../..');

function tool(name: string, tags: ToolDef['tags']): ToolDef {
  return { name, description: name, tags, parameters: { type: 'object', properties: {} }, handler: async () => '' };
}

function world(id: string, tools: ToolDef[]): World {
  return { id, envPromptVars: () => ({}), tools: () => tools, start: async () => {}, stop: async () => {} } as unknown as World;
}

interface FakeCore extends CoreApi {
  injected: string[];
  deferred: string[];
  forks: number;
}

function assistantMessage(text = ''): unknown {
  return {
    type: 'message', id: 'msg_test', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

/** 直连 core.llm 的假客户端；默认只回一段空正文，不产生工具调用。 */
function fakeLlm(output?: unknown[] | ((request: { tools?: readonly { name: string }[] }) => unknown[])): ResponseClient {
  const client: ResponseClient = {
    respond: async (request) => ({
      response: {
        id: 'resp_test',
        status: 'completed',
        output: typeof output === 'function' ? output(request as never) : output ?? [assistantMessage()],
      } as never,
      origin: { instance: 'test', module: 'test', model: 'test', compatibilityDomain: 'test' },
      attempts: [],
    }),
    bind: () => client,
  };
  return client;
}

function fakeCore(llm: ResponseClient = fakeLlm()): FakeCore {
  const injected: string[] = [];
  const deferred: string[] = [];
  let forks = 0;
  const info: SessionInfo = { id: 'main', running: 0, snapshot: [], estTokens: null, hardTokens: null };
  const core = {
    injected,
    deferred,
    get forks() { return forks; },
    injectInternal: (text: string) => { injected.push(text); },
    injectDeferred: (kind: string, render: () => string | null) => {
      const text = render();
      if (text) deferred.push(`${kind}:${text}`);
    },
    injectExternal: () => {},
    requestContextHandoff: () => false,
    spawnFork: async () => { forks++; return ''; },
    sessionInfo: () => info,
    llm,
    timers: {
      set: () => ({ ok: true as const, id: 't1' }),
      cancel: () => true,
      list: () => [],
      clearAll: () => 0,
      onDue: () => {},
    },
    deliveryGate: {} as never,
    personaState: () => ({}),
    savePersonaState: () => {},
    toolsTagged: () => new Set<string>(),
    blob: () => null,
    log: {
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    },
  } as unknown as FakeCore;
  return core;
}

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    cursor: 1,
    type: 'qq.message',
    ts: '2026-11-04T10:00:00.000Z',
    source: 'qq',
    origin: 'external',
    text: '你在吗？',
    senderKey: 'u1',
    meta: { conv: { kind: 'private', id: 1 } },
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function makePersona(
  overrides: Record<string, unknown> = {},
  llm: ResponseClient = fakeLlm(),
) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const cfg = testConfig({
    providers: {
      test: {
        kind: 'openai-responses-compat',
        baseUrl: 'http://test',
        spec: { model: 'test', thinking: false },
      },
    },
    activeProvider: 'test',
    decision: { enabled: false },
    vectors: { enabled: false },
    ...overrides,
  });
  const worlds = [
    world('qq', [tool('qq_draft', ['speak']), tool('qq_confirm', ['speak'])]),
    world('voice', [tool('voice_speak', ['speak'])]),
  ];
  const persona = new HeartPersona({
    memoryDir: tmp.dir,
    packageDir: PACKAGE_DIR,
    promptDir: join(tmp.dir, 'prompts'),
    worlds,
    config: () => cfg,
    secret: () => '',
    logger: { warn: (m, d) => console.error('WARN', m, d), info: (m, d) => console.error('INFO', m, d) },
  });
  const core = fakeCore(llm);
  persona.attach(core);
  return { persona, core, cfg, dir: tmp.dir };
}

describe('HeartPersona integration', () => {
  it('decides to respond to a private QQ message and routes text/voice through QQ', async () => {
    const { persona, core } = makePersona();
    await persona.onDelivery({ events: [event()] });
    const head = persona.sessionHead();
    const text = JSON.stringify(head);
    expect(text).toContain('qq_draft');
    expect(text).toContain('private:1');
    expect(text).toContain('turn plan');
    persona.onBatchEnd();
    persona.shutdown();
  });

  it('injects a semantic silence instruction for ambient group chatter', async () => {
    const { persona, core } = makePersona();
    await persona.onDelivery({
      events: [event({ meta: { conv: { kind: 'group', id: 9 } }, text: '今天天气不错' })],
    });
    expect(core.injected.some((t) => t.includes('不值得回应'))).toBe(true);
    const head = JSON.stringify(persona.sessionHead());
    expect(head).toContain('保持沉默');
    persona.onBatchEnd();
    persona.shutdown();
  });

  it('does not enqueue internal-only batches for a turn decision', async () => {
    const { persona, core } = makePersona();
    await persona.onDelivery({
      events: [{
        cursor: 2, type: 'memory.result', ts: '2026-11-04T10:00:00.000Z',
        source: 'core', origin: 'internal', text: '记忆已整理',
      }],
    });
    expect(core.injected).toHaveLength(0);
    persona.shutdown();
  });

  it('runs the memory worker directly through core.llm without a fork or wake-up', async () => {
    const llm = fakeLlm(() => [{
      type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'memory_propose', status: 'completed',
      arguments: JSON.stringify({
        ops: [{
          op: 'create',
          candidate: {
            kind: 'preference',
            title: '喜欢美式',
            content: '他早上通常喝美式，不加糖。',
            scope_type: 'person',
            scope_id: 'u1',
            sensitivity: 'normal',
          },
        }],
      }),
    }]);
    const { persona, core } = makePersona({}, llm);
    await persona.onDelivery({ events: [event({ text: '我早上都喝美式' })] });
    persona.onBatchEnd();
    // 钩子已返回；后台 worker 继续跑。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(persona.store.stats().active).toBe(1);
    // 不创建 fork/session 窗口。
    expect(core.forks).toBe(0);
    // 自主记忆保持静默：不向主会话注入任何回执。
    expect(core.deferred).toHaveLength(0);
    expect(core.injected).toHaveLength(0);
    persona.shutdown();
  });

  it('detects explicit memory requests and keeps them replying', () => {
    expect(isExplicitMemoryRequest('记住我叫空空')).toBe(true);
    expect(isExplicitMemoryRequest('再记一下我的名字')).toBe(true);
    expect(isExplicitMemoryRequest('remember my name is Kong')).toBe(true);
    expect(isExplicitMemoryRequest('今天天气不错')).toBe(false);
    expect(isExplicitMemoryRequest('没记住就算了')).toBe(false);
    expect(isExplicitMemoryRequest('你记得吗')).toBe(false);
  });

  it('treats a user_id-only event as a private conversation', async () => {
    const { persona } = makePersona();
    await persona.onDelivery({ events: [event({ meta: { user_id: '10086' }, text: '在么' })] });
    const head = JSON.stringify(persona.sessionHead());
    expect(head).toContain('private:10086');
    expect(head).toContain('回应');
    persona.onBatchEnd();
    persona.shutdown();
  });

  it('reads deployment prompt overrides before package templates', async () => {
    const { persona, dir } = makePersona();
    const prompts = join(dir, 'prompts');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, 'PREFIX.md'), '# Override\n\n{{persona.displayName}} 的部署前缀。', 'utf8');
    const segments = await persona.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });
    const prefix = segments.find((s) => s.title === 'PREFIX');
    expect(prefix?.text).toContain('部署前缀');
    expect(prefix?.text).not.toContain('先问「我想说什么」');
    persona.shutdown();
  });

  it('renders static persona segments and a dynamic head', async () => {
    const { persona } = makePersona();
    const segments = await persona.systemSegments({
      now: new Date(),
      timezone: 'Asia/Shanghai',
      worlds: [{ id: 'qq', envPrompt: 'QQ env' }],
    });
    expect(segments.map((s) => s.title)).toContain('PREFIX');
    expect(segments.map((s) => s.text).join('\n')).toContain('先问「我想说什么」');
    expect(segments.map((s) => s.text).join('\n')).toContain('QQ env');
    persona.shutdown();
  });
});
