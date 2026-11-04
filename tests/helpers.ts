import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMerge } from 'cortico/core/config.ts';
import { HEART_DEFAULTS, type HeartConfig } from '../config.ts';

export function testConfig(overrides: Record<string, unknown> = {}): HeartConfig {
  return deepMerge(structuredClone(HEART_DEFAULTS), overrides) as HeartConfig;
}

export function tempDir(prefix = 'heart-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
