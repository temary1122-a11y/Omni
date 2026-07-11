import { describe, expect, it, vi, afterEach } from 'vitest';
import { runBuildVerifyLoop } from '../../../src/pipeline/verifyLoop';
import { buildPhase } from '../../../src/pipeline/phases/BuildPhase';
import { auditSecurityPhase } from '../../../src/pipeline/phases/AuditSecurityPhase';
import { verifyPhase } from '../../../src/pipeline/phases/VerifyPhase';
import { createPipelineContext } from '../../../src/pipeline/types';
import type { PipelineHost, PipelineServices } from '../../../src/pipeline/types';

function makeHost(): PipelineHost {
  return {
    workspaceRoot: '/tmp/ws',
    eventBus: { emit: vi.fn() } as unknown as PipelineHost['eventBus'],
    phaseEngine: {} as PipelineHost['phaseEngine'],
    chat: vi.fn(),
    setAgent: vi.fn(),
    transitionPhase: vi.fn(),
    runPhaseSafely: vi.fn(async (fn) => fn()),
    requestApiKeyPrompt: vi.fn(),
    askClarifyingQuestions: vi.fn(async () => []),
    refineGoal: vi.fn((g) => g),
    requestApproval: vi.fn(),
    emitArtifact: vi.fn(),
    emitPhaseLifecycle: vi.fn(),
    assertNotCancelled: vi.fn(),
    isCancelled: vi.fn(() => false),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runBuildVerifyLoop', () => {
  it('retries build on verify reject then accepts', async () => {
    vi.spyOn(buildPhase, 'run').mockImplementation(async (_h, ctx) => {
      ctx.artifacts = [{ filePath: 'a.ts', content: 'c', hash: 'h' }];
      return { phase: 'build' };
    });
    vi.spyOn(auditSecurityPhase, 'run').mockResolvedValue({ phase: 'audit' });
    vi.spyOn(verifyPhase, 'run')
      .mockResolvedValueOnce({
        phase: 'verify',
        verdict: {
          verdict: 'FAIL',
          subtaskId: 'v1',
          criteria: [],
          risks: [],
          decision: 'REJECT',
          feedback: 'fix',
        },
        decision: 'reject',
      })
      .mockResolvedValueOnce({
        phase: 'verify',
        verdict: {
          verdict: 'PASS',
          subtaskId: 'v1',
          criteria: [],
          risks: [],
          decision: 'ACCEPT',
        },
        decision: 'accept',
      });

    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'g',
      workspace: { fileTree: [] },
      goalPacket: { taskId: 't1', intent: 'build', complexity: 'high', constraints: [] },
      tier: 'HIGH',
      phases: ['build', 'verify'],
    });
    ctx.contextPacket = { taskId: 't1', goal: 'g', workspaceSnapshot: { fileTree: [] } };

    const onBeforeRetry = vi.fn();
    const result = await runBuildVerifyLoop(makeHost(), ctx, {} as PipelineServices, {
      maxRetries: 3,
      onBeforeRetry,
    });

    expect(onBeforeRetry).toHaveBeenCalledTimes(1);
    expect(result.verdict.verdict).toBe('PASS');
    expect(ctx.contextPacket?.bounceContext?.feedback).toBe('fix');
    expect(buildPhase.run).toHaveBeenCalledTimes(2);
  });
});
