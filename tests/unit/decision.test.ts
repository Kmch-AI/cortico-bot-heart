import { describe, expect, it } from 'vitest';
import { SystemOneClient } from '../../decision/systemone.ts';
import { SystemOneError } from '../../decision/types.ts';
import { DecisionPlane } from '../../decision/fallback.ts';
import { TURN_PLAN_STATE_BUDGET, estimateDecisionTokens, turnPlanQuestions, turnPlanState } from '../../decision/questions.ts';
import type { TurnPlanInput } from '../../output/turnPlan.ts';
import { testConfig } from '../helpers.ts';

const input: TurnPlanInput = {
  text: '你在吗？',
  source: 'qq',
  addressed: true,
  isPrivate: true,
  mentioned: false,
  mood: { valence: 0.1, energy: 0.6, tension: 0.2, playfulness: 0.3, openness: 0.6, patience: 0.6, label: '平静' },
  relationship: { familiarity: 0.5, trust: 0.5, intimacy: 0.3, tension: 0.1, status: 'friendly' },
};

function response(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ model: 'jev', answers }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('SystemOne client and decision plane', () => {
  it('parses typed answers into a turn plan', async () => {
    let sent: { state?: unknown; questions?: Record<string, { criteria?: unknown; legend?: unknown }> } | undefined;
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return response({
        action: { type: 'choice', choice: 'respond', confidence: 0.82, probabilities: { respond: 0.82, silence: 0.1, defer: 0.08 } },
        addressed: { type: 'noul', noul: 0.9 },
        voice: { type: 'noul', noul: 0.7 },
        needs_arbiter: { type: 'noul', noul: 0.2 },
        intent: { type: 'choice', choice: 'acknowledge', confidence: 0.7, probabilities: {} },
        stance: { type: 'choice', choice: 'neutral', confidence: 0.6, probabilities: {} },
        depth: { type: 'score', score: 2, confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
        length: { type: 'choice', choice: 'short', confidence: 0.7, probabilities: {} },
        directness: { type: 'choice', choice: 'neutral', confidence: 0.7, probabilities: {} },
        playfulness: { type: 'score', score: 1, confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
      });
    };
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch: fakeFetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan } = await plane.plan(input, { events: 'hi' });
    expect(plan.action).toBe('respond');
    expect(plan.addressed).toBe(true);
    expect(plan.voice).toBe(true);
    expect(plan.cognitiveDepth).toBe('L2');
    expect(plan.length).toBe('short');
    expect(plan.confidence).toBeCloseTo(0.82, 2);
    // 只问核心语义；其余字段由答案和状态推导。
    expect(Object.keys(sent?.questions ?? {}).sort()).toEqual(['action', 'intent', 'length', 'stance', 'voice']);
    expect(sent?.questions?.depth).toBeUndefined();
    expect(sent?.questions?.addressed).toBeUndefined();
    expect(sent?.questions?.needs_arbiter).toBeUndefined();
    expect(JSON.stringify(sent?.state).length).toBeLessThan(4000);
  });

  it('forces a direct reply when the model is only weakly silent', async () => {
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: 'silence', confidence: 0.12, probabilities: { respond: 0.36, silence: 0.39, defer: 0.25 } },
      intent: { type: 'choice', choice: 'close', confidence: 0.5, probabilities: {} },
      stance: { type: 'choice', choice: 'neutral', confidence: 0.5, probabilities: {} },
      length: { type: 'choice', choice: 'short', confidence: 0.5, probabilities: {} },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan, trace } = await plane.plan(input, {});
    expect(trace.mode).toBe('systemone');
    expect(plan.action).toBe('respond');
    expect(plan.reason).toContain('direct low-confidence silence -> respond');
  });

  it('keeps a confident direct silence', async () => {
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: 'silence', confidence: 0.88, probabilities: { respond: 0.07, silence: 0.88, defer: 0.05 } },
      intent: { type: 'choice', choice: 'close', confidence: 0.8, probabilities: {} },
      stance: { type: 'choice', choice: 'neutral', confidence: 0.8, probabilities: {} },
      length: { type: 'choice', choice: 'short', confidence: 0.8, probabilities: {} },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan } = await plane.plan(input, {});
    expect(plan.action).toBe('silence');
  });

  it('still turns a weak ambient reply into silence', async () => {
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: 'respond', confidence: 0.2, probabilities: { respond: 0.2, silence: 0.5, defer: 0.3 } },
      intent: { type: 'choice', choice: 'share', confidence: 0.5, probabilities: {} },
      stance: { type: 'choice', choice: 'neutral', confidence: 0.5, probabilities: {} },
      length: { type: 'choice', choice: 'short', confidence: 0.5, probabilities: {} },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan } = await plane.plan({ ...input, addressed: false, isPrivate: false }, {});
    expect(plan.action).toBe('silence');
    expect(plan.reason).toContain('low confidence -> silence');
  });

  it('asks five appraisal scores and derives importance', async () => {
    let sent: { questions?: Record<string, { criteria?: unknown }> } | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return response({
        valence: { type: 'score', score: 3, confidence: 0.7, legend: {}, probabilities: {} },
        arousal: { type: 'score', score: 2, confidence: 0.7, legend: {}, probabilities: {} },
        energy: { type: 'score', score: 2, confidence: 0.7, legend: {}, probabilities: {} },
        tension: { type: 'score', score: 1, confidence: 0.7, legend: {}, probabilities: {} },
        relationship_delta: { type: 'score', score: 4, confidence: 0.7, legend: {}, probabilities: {} },
      });
    };
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const appraisal = await plane.appraise('hi', { mood: { valence: 0.1, energy: 0.6, tension: 0.2 }, relationship: { familiarity: 0.5, trust: 0.5 } });
    expect(Object.keys(sent?.questions ?? {}).sort()).toEqual(['arousal', 'energy', 'relationship_delta', 'tension', 'valence']);
    expect(sent?.questions?.valence?.criteria).toEqual(['很不悦', '不悦', '中性', '愉悦', '很愉悦']);
    expect(appraisal?.importance).toBeGreaterThan(0.35);
  });

  it('maps a fractional expected score to the nearest level', async () => {
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: 'respond', confidence: 0.8, probabilities: {} },
      addressed: { type: 'noul', noul: 0.9 },
      voice: { type: 'noul', noul: 0.1 },
      needs_arbiter: { type: 'noul', noul: 0.1 },
      intent: { type: 'choice', choice: 'acknowledge', confidence: 0.7, probabilities: {} },
      stance: { type: 'choice', choice: 'neutral', confidence: 0.6, probabilities: {} },
      depth: { type: 'score', score: 2.6, confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
      length: { type: 'choice', choice: 'short', confidence: 0.7, probabilities: {} },
      directness: { type: 'choice', choice: 'neutral', confidence: 0.7, probabilities: {} },
      playfulness: { type: 'score', score: 2, confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan } = await plane.plan(input, {});
    expect(plan.cognitiveDepth).toBe('L3');
    expect(plan.playfulness).toBeCloseTo(0.5, 2);
  });

  it('accepts a null choice as abstention instead of rejecting the response', async () => {
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: null, confidence: 0.9, probabilities: {}, none_probability: 0.7 },
      addressed: { type: 'noul', noul: 0.9 },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan, trace } = await plane.plan(input, {});
    expect(trace.mode).toBe('systemone');
    expect(plan.action).toBe('respond');
  });

  it('falls back to heuristic on timeout and does not throw', async () => {
    const fetch = async (): Promise<Response> => { throw new Error('offline'); };
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 100, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 100, confidenceThreshold: 0.5 });
    const { plan, trace } = await plane.plan(input, {});
    expect(plan.action).toBe('respond');
    expect(trace.mode).toBe('heuristic');
    expect(trace.error).toContain('network');
  });

  it('uses the shared timeout with one attempt on the turn-plan path', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 100, fetch });
    const plane = new DecisionPlane({
      client,
      timeoutMs: 100,
      confidenceThreshold: 0.5,
    });
    const started = Date.now();
    const { plan, trace } = await plane.plan(input, {});
    expect(plan.action).toBe('respond');
    expect(trace.mode).toBe('heuristic');
    expect(trace.error).toContain('timeout');
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('omits the voice question when there is no voice outlet or the user asked explicitly', () => {
    expect(Object.keys(turnPlanQuestions({ voiceAvailable: false })).sort()).toEqual(['action', 'intent', 'length', 'stance']);
    expect(Object.keys(turnPlanQuestions({ voiceAvailable: true, explicitVoiceRequested: true })).sort()).toEqual(['action', 'intent', 'length', 'stance']);
    expect(Object.keys(turnPlanQuestions({ voiceAvailable: true })).sort()).toContain('voice');
  });

  it('keeps the turn-plan state inside its token budget', () => {
    const state = turnPlanState({
      eventSummary: '长消息'.repeat(2000),
      recent: Array.from({ length: 12 }, () => '最近对话内容'.repeat(80)).join('\n'),
      mood: { valence: 0.1, arousal: 0.3, energy: 0.6, tension: 0.2, openness: 0.6, patience: 0.6, playfulness: 0.3, label: '平静' },
      relationship: { familiarity: 0.5, trust: 0.5, intimacy: 0.3, tension: 0.1, status: 'friendly' },
      hot: ['记忆'.repeat(200), '另一条'.repeat(200), '第三条'.repeat(200), '第四条'.repeat(200)],
      delivery: { source: 'qq', target: 'private:1', text: 'qq', voice: 'qq' },
      input,
    });
    expect(estimateDecisionTokens(state)).toBeLessThanOrEqual(TURN_PLAN_STATE_BUDGET);
  });

  it('rejects oversized state before sending', async () => {
    let called = false;
    const fetch = async (): Promise<Response> => { called = true; return response({ answer: { type: 'noul', noul: 0.5 } }); };
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    await expect(client.ask({ state: 'x'.repeat(300_000), questions: {
      a: { type: 'noul', instructions: 'a' },
      b: { type: 'noul', instructions: 'b' },
    } })).rejects.toBeInstanceOf(SystemOneError);
    expect(called).toBe(false);
  });

  it('exposes config defaults for baseline mood', () => {
    const cfg = testConfig();
    expect(cfg.mood.inertia).toBeGreaterThan(0);
    expect(cfg.decision.timeoutMs).toBeGreaterThan(0);
    expect('interactiveTimeoutMs' in cfg.decision).toBe(false);
  });
});
