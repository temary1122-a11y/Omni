import { describe, expect, it, vi } from 'vitest';
import { SelfPromptPhase } from '../../../src/pipeline/phases/SelfPromptPhase';
import { ContextEnrichPhase } from '../../../src/pipeline/phases/ContextEnrichPhase';
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
    getElapsedMs: () => 100,
    scanWorkspace: vi.fn(async () => ({ fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] })),
    draftProjectDocs: vi.fn(async () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' })),
    readProjectDocs: () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' }),
  };
}

describe('SelfPromptPhase', () => {
  it('skips when useSelfPrompting is false', async () => {
    const phase = new SelfPromptPhase();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'goal',
      workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      goalPacket: {
        taskId: 't1',
        intent: 'build',
        complexity: 'low',
        goal: 'goal',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
      tier: 'LOW',
      phases: ['build'],
    });
    const outcome = await phase.run(makeHost(), ctx, {} as PipelineServices);
    expect(outcome.skipped).toBe(true);
  });

  it('refines goal when loop converges', async () => {
    const phase = new SelfPromptPhase();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'goal',
      workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      goalPacket: {
        taskId: 't1',
        intent: 'build',
        complexity: 'high',
        goal: 'goal',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
      tier: 'HIGH',
      phases: ['planning'],
    });
    ctx.useSelfPrompting = true;
    const services = {
      promptOrchestrator: {
        runSelfPromptingLoop: vi.fn(async () => ({
          converged: true,
          finalGoal: 'refined goal',
          rounds: 2,
          conversationHistory: [],
        })),
      },
    } as unknown as PipelineServices;

    await phase.run(makeHost(), ctx, services);
    expect(ctx.refinedGoal).toBe('refined goal');
  });
});

describe('ContextEnrichPhase', () => {
  it('announces memory context when enrichment found', async () => {
    const phase = new ContextEnrichPhase();
    const host = makeHost();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'g',
      workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      goalPacket: {
        taskId: 't1',
        intent: 'build',
        complexity: 'low',
        goal: 'g',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
      tier: 'LOW',
      phases: ['build'],
    });
    ctx.contextPacket = { taskId: 't1', goal: 'g', workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] } };

    const services = {
      contextAgent: {
        enrich: vi.fn(async () => ({
          memoryContext: '=== Context ===',
          episodeCount: 2,
          skillFound: true,
          artifactCount: 1,
          semanticNodeCount: 0,
        })),
      },
      memory: {
        setContextPacket: vi.fn(),
        getContextPacket: vi.fn(),
      },
    } as unknown as PipelineServices;

    await phase.run(host, ctx, services);
    expect(host.chat).toHaveBeenCalledWith('system', expect.stringContaining('Memory context'));
  });
});
