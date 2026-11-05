import { describe, expect, it } from 'vitest';
import { gateVoice } from '../../output/voice.ts';
import { heuristicTurnPlan, type TurnPlanInput } from '../../output/turnPlan.ts';

const input: TurnPlanInput = {
  text: '发语音给我',
  source: 'qq',
  addressed: true,
  isPrivate: true,
  mentioned: false,
  mood: { valence: 0.1, energy: 0.6, tension: 0.2, playfulness: 0.3, openness: 0.6, patience: 0.6, label: '平静' },
  relationship: { familiarity: 0.5, trust: 0.5, intimacy: 0.3, tension: 0.1, status: 'friendly' },
  voiceAvailable: true,
  explicitVoiceRequested: true,
};

const route = {
  source: 'qq',
  text: 'qq' as const,
  voice: 'qq' as const,
  target: 'private:1',
  textAvailable: true,
  voiceAvailable: true,
};

const cfg = { enabled: true, groupDefault: false, maxPerTurns: 3, explicitKeywords: ['语音'] };

describe('voice gate', () => {
  it('lets an explicit request through even when the model did not answer the voice question', () => {
    const plan = heuristicTurnPlan(input);
    expect(plan.voice).toBe(false);
    expect(gateVoice({
      plan, route, cfg, isPrivate: true, isGroup: false,
      explicitRequested: true, turnsSinceVoice: null, emotionalIntensity: 0,
    }).send).toBe(true);
  });

  it('still refuses when the source has no voice outlet', () => {
    const plan = heuristicTurnPlan(input);
    expect(gateVoice({
      plan, route: { ...route, voice: null, voiceAvailable: false }, cfg, isPrivate: true, isGroup: false,
      explicitRequested: true, turnsSinceVoice: null, emotionalIntensity: 1,
    }).send).toBe(false);
  });
});
