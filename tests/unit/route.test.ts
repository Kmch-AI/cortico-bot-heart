import { describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolDef, World } from 'cortico/core/types.ts';
import { ChannelRouter, formatDeliveryPlan, routeScope } from '../../output/route.ts';

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    cursor: 1,
    type: 'qq.message',
    ts: '2026-11-04T10:00:00.000Z',
    source: 'qq',
    origin: 'external',
    text: '你好',
    ...overrides,
  };
}

function tool(name: string, tags: ToolDef['tags']): ToolDef {
  return { name, description: name, tags, parameters: { type: 'object', properties: {} }, handler: async () => '' };
}

function world(id: string, tools: ToolDef[]): World {
  return {
    id,
    envPromptVars: () => ({}),
    tools: () => tools,
    start: async () => {},
    stop: async () => {},
  } as unknown as World;
}

describe('ChannelRouter', () => {
  it('routes console text directly and voice locally', () => {
    const router = new ChannelRouter([world('voice', [tool('voice_speak', ['speak'])])]);
    const plan = router.route([event({ source: 'console', type: 'console.message', origin: 'internal' })]);
    expect(plan.source).toBe('console');
    expect(plan.text).toBe('console-direct');
    expect(plan.voice).toBe('local');
    expect(plan.voiceAvailable).toBe(true);
    expect(formatDeliveryPlan(plan)).toContain('控制台');
    expect(formatDeliveryPlan(plan)).toContain('直接输出回复正文');
    expect(formatDeliveryPlan(plan)).toContain('console_send 只用于其他来源向控制台广播');
  });

  it('routes QQ text and voice through QQ tools with a target', () => {
    const router = new ChannelRouter([
      world('qq', [tool('qq_draft', ['speak']), tool('qq_confirm', ['speak'])]),
      world('voice', [tool('voice_speak', ['speak'])]),
    ]);
    const plan = router.route([event({ meta: { conv: { kind: 'group', id: 123 } } })]);
    expect(plan.text).toBe('qq');
    expect(plan.voice).toBe('qq');
    expect(plan.target).toBe('group:123');
    expect(routeScope(plan)).toEqual({ type: 'group', id: '123' });
  });

  it('does not fall back to QQ when another world has no speak tool', () => {
    const router = new ChannelRouter([world('bilibili', [])]);
    const plan = router.route([event({ source: 'bilibili' })]);
    expect(plan.text).toBe('none');
    expect(plan.voice).toBeNull();
    expect(plan.textAvailable).toBe(false);
    expect(plan.note).toContain('bilibili');
  });

  it('uses the latest external source in a mixed batch', () => {
    const router = new ChannelRouter([
      world('qq', [tool('qq_draft', ['speak']), tool('qq_confirm', ['speak'])]),
      world('voice', [tool('voice_speak', ['speak'])]),
    ]);
    const plan = router.route([
      event({ cursor: 1, source: 'console', type: 'console.message', origin: 'internal' }),
      event({ cursor: 2, meta: { conv: { kind: 'private', id: 9 } } }),
    ]);
    expect(plan.source).toBe('qq');
    expect(plan.target).toBe('private:9');
  });
});
