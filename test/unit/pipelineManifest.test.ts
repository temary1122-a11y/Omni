import { describe, expect, it } from 'vitest';
import { TIER_PHASE_MANIFEST, tierIncludesPhase } from '../../src/pipeline/pipelineManifest';

describe('pipelineManifest', () => {
  it('defines phases for every tier', () => {
    expect(TIER_PHASE_MANIFEST.LOW.length).toBeGreaterThan(0);
    expect(TIER_PHASE_MANIFEST.MEDIUM.length).toBeGreaterThan(0);
    expect(TIER_PHASE_MANIFEST.HIGH.length).toBeGreaterThan(0);
  });

  it('adds verify only from MEDIUM upward', () => {
    expect(TIER_PHASE_MANIFEST.LOW).not.toContain('verify');
    expect(TIER_PHASE_MANIFEST.MEDIUM).toContain('verify');
    expect(TIER_PHASE_MANIFEST.HIGH).toContain('verify');
  });

  it('adds audit and security only in HIGH', () => {
    for (const tier of ['LOW', 'MEDIUM'] as const) {
      expect(TIER_PHASE_MANIFEST[tier]).not.toContain('audit');
      expect(TIER_PHASE_MANIFEST[tier]).not.toContain('security');
    }
    expect(TIER_PHASE_MANIFEST.HIGH).toContain('audit');
    expect(TIER_PHASE_MANIFEST.HIGH).toContain('security');
  });

  it('always includes intake and deliver', () => {
    for (const tier of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      expect(TIER_PHASE_MANIFEST[tier][0]).toBe('intake');
      expect(TIER_PHASE_MANIFEST[tier].at(-1)).toBe('deliver');
    }
  });

  it('tierIncludesPhase reflects the manifest', () => {
    expect(tierIncludesPhase('LOW', 'build')).toBe(true);
    expect(tierIncludesPhase('LOW', 'security')).toBe(false);
    expect(tierIncludesPhase('HIGH', 'security')).toBe(true);
  });
});
