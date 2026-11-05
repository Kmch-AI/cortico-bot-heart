/**
 * 渠道路由：信息从哪来，文字/语音就回哪。
 *
 * 决策层只回答“这一句要不要发语音”；这里只回答“如果要发，走哪条路”。
 * 不直接执行工具，不合成语音，不连平台。
 */
import type { EventEnvelope, ToolDef, World } from 'cortico/core/types.ts';

export interface DeliveryPlan {
  source: string;
  text: 'console-direct' | 'qq' | 'world-tool' | 'none';
  voice: 'local' | 'qq' | 'world-tool' | null;
  target?: string;
  /** 该来源是否具备文本/语音出口；用于 trace 与提示词。 */
  textAvailable: boolean;
  voiceAvailable: boolean;
  note?: string;
}

export interface RouteOptions {
  /** 找不到来源时的默认渠道；不配置就不发。 */
  fallbackSource?: string;
}

function safeTools(world: World | undefined): ToolDef[] {
  if (!world) return [];
  try { return world.tools(); } catch { return []; }
}

function hasTool(tools: readonly ToolDef[], name: string): boolean {
  return tools.some((t) => t.name === name);
}

function speakTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter((t) => t.tags.includes('speak'));
}

function targetOf(event: EventEnvelope | undefined): string | undefined {
  const meta = event?.meta ?? {};
  const conv = meta.conv;
  if (typeof conv === 'string' && conv.trim()) return conv;
  if (conv && typeof conv === 'object') {
    const c = conv as { kind?: unknown; id?: unknown };
    const kind = typeof c.kind === 'string' ? c.kind : '';
    const id = typeof c.id === 'string' || typeof c.id === 'number' ? String(c.id) : '';
    if ((kind === 'group' || kind === 'private') && id) return `${kind}:${id}`;
  }
  const replyTo = meta.reply_to;
  if (typeof replyTo === 'string' && replyTo.trim()) return replyTo;
  const group = meta.group_id;
  if (typeof group === 'string' && group.trim()) return `group:${group}`;
  const user = meta.user_id;
  if (typeof user === 'string' && user.trim()) return `private:${user}`;
  return undefined;
}

function latestExternal(events: readonly EventEnvelope[]): EventEnvelope | undefined {
  return events
    .filter((e) => e.origin === 'external'
      || (e.source === 'console' && (e.type === 'console.message' || e.type === 'console.invite')))
    .sort((a, b) => (a.cursor - b.cursor) || (Date.parse(a.ts) - Date.parse(b.ts)))
    .at(-1);
}

export class ChannelRouter {
  constructor(private readonly worlds: readonly World[], private readonly opts: RouteOptions = {}) {}

  route(events: readonly EventEnvelope[]): DeliveryPlan {
    const event = latestExternal(events);
    const source = event?.source ?? this.opts.fallbackSource;
    if (!source) {
      return { source: 'unknown', text: 'none', voice: null, textAvailable: false, voiceAvailable: false, note: '没有外部来源，不主动发' };
    }
    if (source === 'console') {
      const voiceWorld = this.worlds.find((w) => w.id === 'voice');
      const voiceTools = safeTools(voiceWorld);
      const voiceAvailable = hasTool(voiceTools, 'voice_speak');
      return {
        source,
        text: 'console-direct',
        voice: voiceAvailable ? 'local' : null,
        textAvailable: true,
        voiceAvailable,
        note: voiceAvailable ? undefined : '语音 World 未挂载或没有 voice_speak',
      };
    }
    if (source === 'qq') {
      const qq = this.worlds.find((w) => w.id === 'qq');
      const qqTools = safeTools(qq);
      const voiceWorld = this.worlds.find((w) => w.id === 'voice');
      const voiceTools = safeTools(voiceWorld);
      const textAvailable = hasTool(qqTools, 'qq_draft') && hasTool(qqTools, 'qq_confirm');
      const voiceAvailable = textAvailable && hasTool(voiceTools, 'voice_speak');
      return {
        source,
        text: textAvailable ? 'qq' : 'none',
        voice: voiceAvailable ? 'qq' : null,
        target: targetOf(event),
        textAvailable,
        voiceAvailable,
        note: textAvailable ? undefined : 'QQ World 未挂载或缺少 qq_draft/qq_confirm',
      };
    }
    const world = this.worlds.find((w) => w.id === source);
    if (!world) {
      return { source, text: 'none', voice: null, target: targetOf(event), textAvailable: false, voiceAvailable: false, note: `来源 ${source} 未挂载` };
    }
    const tools = safeTools(world);
    const speaks = speakTools(tools);
    const textAvailable = speaks.length > 0;
    const voiceAvailable = speaks.some((t) => /voice|speak|say|tts/i.test(t.name));
    return {
      source,
      text: textAvailable ? 'world-tool' : 'none',
      voice: voiceAvailable ? 'world-tool' : null,
      target: targetOf(event),
      textAvailable,
      voiceAvailable,
      note: textAvailable ? undefined : `来源 ${source} 没有 speak 工具`,
    };
  }
}

export function formatDeliveryPlan(plan: DeliveryPlan): string {
  const text = plan.text === 'console-direct' ? '直接输出回复正文；console_send 只用于其他来源向控制台广播'
    : plan.text === 'qq' ? 'qq_draft → qq_confirm'
      : plan.text === 'world-tool' ? '调用该 World 的 speak 工具'
        : '没有文字出口，本回合不要发送';
  const voice = plan.voice === 'local' ? 'voice_speak（本机播放）'
    : plan.voice === 'qq' ? 'voice_speak({silent:true}) → qq_draft({voice}) → qq_confirm'
      : plan.voice === 'world-tool' ? '调用该 World 的语音工具'
        : '没有语音出口';
  return [
    `来源 ${plan.source}${plan.target ? ` → ${plan.target}` : ''}`,
    `文字：${text}`,
    `语音：${voice}`,
    plan.note ? `注意：${plan.note}` : '',
  ].filter(Boolean).join('；');
}

export function routeScope(plan: DeliveryPlan): { type: 'group' | 'person' | 'global'; id?: string } {
  const target = plan.target ?? '';
  if (target.startsWith('group:')) return { type: 'group', id: target.slice(6) };
  if (target.startsWith('private:')) return { type: 'person', id: target.slice(8) };
  if (plan.source === 'qq') return { type: 'global' };
  return { type: 'global' };
}
