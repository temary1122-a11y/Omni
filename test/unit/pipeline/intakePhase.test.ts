import { describe, expect, it, vi } from 'vitest';
import { IntakePhase } from '../../../src/pipeline/phases/IntakePhase';
import { createPipelineContext } from '../../../src/pipeline/types';
import type { PipelineHost, PipelineServices } from '../../../src/pipeline/types';
import type { UserGoalPacket } from '../../../shared/types';
import { scanWorkspace } from '../../../src/pipeline/intakeUtils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeHost(): PipelineHost {
  return {
    workspaceRoot: '/tmp/ws',
    eventBus: { emit: vi.fn() } as unknown as PipelineHost['eventBus'],
    phaseEngine: { transitionTo: vi.fn() } as unknown as PipelineHost['phaseEngine'],
    chat: vi.fn(),
    setAgent: vi.fn(),
    transitionPhase: vi.fn(),
    runPhaseSafely: vi.fn(async (fn) => fn()),
    requestApiKeyPrompt: vi.fn(),
    askClarifyingQuestions: vi.fn(async () => []),
    refineGoal: vi.fn((g) => g),
    requestApproval: vi.fn(async () => ({ approved: true, feedback: '', requestId: 'req-1' })),
    emitArtifact: vi.fn(),
    emitPhaseLifecycle: vi.fn(),
    getElapsedMs: () => 100,
    scanWorkspace: vi.fn(async () => ({ fileTree: ['src/'], hasPackageJson: true, hasReadme: false, techStack: ['typescript'] })),
    draftProjectDocs: vi.fn(async () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' })),
    readProjectDocs: () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' }),
  };
}

describe('IntakePhase', () => {
  it('scans workspace and creates goal packet', async () => {
    const phase = new IntakePhase();
    const host = makeHost();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'build a REST API',
      workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      goalPacket: {
        taskId: 't1',
        intent: 'build',
        complexity: 'low',
        goal: 'build a REST API',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
      tier: 'LOW',
      phases: ['intake'],
    });

    const goalPacket: UserGoalPacket = {
      taskId: 't1',
      intent: 'build',
      complexity: 'medium',
      goal: 'build a REST API',
      workspaceSnapshot: { fileTree: ['src/'], hasPackageJson: true, hasReadme: false, techStack: ['typescript'] },
    };

    const services = {
      clarifier: {
        execute: vi.fn(async () => ({
          artifacts: [{ content: JSON.stringify(goalPacket), filePath: 'goal-packet.json' }],
        })),
      },
      memory: {
        setGoalPacket: vi.fn(),
      },
      roleSelector: {
        select: vi.fn(() => ({
          tier: 'MEDIUM' as const,
          roles: ['clarifier', 'researcher', 'planner', 'coder', 'verifier'],
          phases: ['research', 'planning', 'build', 'verify'],
          useSelfPrompting: false,
        })),
      },
      modelIndexer: undefined,
      router: undefined,
    } as unknown as PipelineServices;

    const outcome = await phase.run(host, ctx, services);

    expect(host.scanWorkspace).toHaveBeenCalled();
    expect(services.clarifier.execute).toHaveBeenCalled();
    expect(services.memory.setGoalPacket).toHaveBeenCalledWith(goalPacket);
    expect(services.roleSelector.select).toHaveBeenCalled();
    expect(ctx.tier).toBe('MEDIUM');
    expect(ctx.phases).toEqual(['research', 'planning', 'build', 'verify']);
    expect(ctx.useSelfPrompting).toBe(false);
    expect(outcome.phase).toBe('intake');
    expect(outcome.skipped).toBeUndefined();
  });

  it('always runs (canRun returns true)', () => {
    const phase = new IntakePhase();
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
      phases: [],
    });
    expect(phase.canRun(ctx)).toBe(true);
  });

  it('propagates workspace scan failures', async () => {
    const missingRoot = path.join(os.tmpdir(), `omni-missing-${Date.now()}`);
    await expect(scanWorkspace(missingRoot)).rejects.toThrow(
      `Unable to scan workspace "${missingRoot}"`
    );
  });

  it('propagates malformed package.json errors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-intake-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ invalid', 'utf-8');
      await expect(scanWorkspace(root)).rejects.toThrow('Unable to read workspace package.json');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
