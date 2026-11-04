import { describe, expect, it } from 'vitest';
import { SystemOneClient } from '../../decision/systemone.ts';
import { SystemOneError } from '../../decision/types.ts';
import { DecisionPlane } from '../../decision/fallback.ts';
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
    const fetch = async (): Promise<Response> => response({
      action: { type: 'choice', choice: 'respond', confidence: 0.82, probabilities: { respond: 0.82, silence: 0.1, defer: 0.08 } },
      addressed: { type: 'noul', noul: 0.9 },
      voice: { type: 'noul', noul: 0.7 },
      needs_arbiter: { type: 'noul', noul: 0.2 },
      intent: { type: 'choice', choice: 'acknowledge', confidence: 0.7, probabilities: {} },
      stance: { type: 'choice', choice: 'neutral', confidence: 0.6, probabilities: {} },
      depth: { type: 'score', score: '2', confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
      length: { type: 'choice', choice: 'short', confidence: 0.7, probabilities: {} },
      directness: { type: 'choice', choice: 'neutral', confidence: 0.7, probabilities: {} },
      playfulness: { type: 'score', score: '1', confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
    });
    const client = new SystemOneClient({ baseUrl: 'http://service', model: 'jev', timeoutMs: 500, fetch });
    const plane = new DecisionPlane({ client, timeoutMs: 500, confidenceThreshold: 0.5 });
    const { plan } = await plane.plan(input, { events: 'hi' });
    expect(plan.action).toBe('respond');
    expect(plan.addressed).toBe(true);
    expect(plan.voice).toBe(true);
    expect(plan.cognitiveDepth).toBe('L2');
    expect(plan.length).toBe('short');
    expect(plan.confidence).toBeCloseTo(0.82, 2);
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
  });
});
