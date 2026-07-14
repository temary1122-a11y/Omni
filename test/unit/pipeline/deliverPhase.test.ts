import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliverPhase } from '../../../src/pipeline/phases/DeliverPhase';
import { createPipelineContext } from '../../../src/pipeline/types';
import type { PipelineHost, PipelineServices } from '../../../src/pipeline/types';
import { detectRunInstructions } from '../../../src/pipeline/deliverUtils';
import { CrossPlatformShell } from '../../../src/shell/CrossPlatformShell';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

afterEach(() => {
  vi.restoreAllMocks();
});

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
    getElapsedMs: () => 5000,
  };
}

describe('DeliverPhase', () => {
  it('delivers artifacts and emits DELIVERY_COMPLETE', async () => {
    const phase = new DeliverPhase();
    const host = makeHost();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'g',
      workspace: { fileTree: [] },
      goalPacket: { taskId: 't1', intent: 'build', complexity: 'low', constraints: [] },
      tier: 'HIGH',
      phases: ['deliver'],
    });
    ctx.verdict = { verdict: 'PASS', subtaskId: 'v1', criteria: [], risks: [], decision: 'ACCEPT' };
    ctx.artifacts = [{ filePath: 'src/app.ts', content: 'code', hash: 'h' }];

    const services = {
      artifacts: { openInEditor: vi.fn(async () => {}), listGenerated: vi.fn(() => []) },
      ledger: { getLedgerPath: vi.fn(() => '/ledger.jsonl'), append: vi.fn() },
    } as unknown as PipelineServices;

    const outcome = await phase.run(host, ctx, services);

    expect(outcome.report?.verdict).toBe('PASS');
    expect(ctx.deliveryReport).toBeDefined();
    expect(host.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DELIVERY_COMPLETE' })
    );
    expect(services.ledger.append).toHaveBeenCalled();
  });

  it('skips open editor on FAIL for HIGH tier', async () => {
    const phase = new DeliverPhase();
    const host = makeHost();
    const ctx = createPipelineContext({
      taskId: 't1',
      rawGoal: 'g',
      workspace: { fileTree: [] },
      goalPacket: { taskId: 't1', intent: 'build', complexity: 'high', constraints: [] },
      tier: 'HIGH',
      phases: ['deliver'],
    });
    ctx.verdict = { verdict: 'FAIL', subtaskId: 'v1', criteria: [], risks: [] };
    ctx.artifacts = [{ filePath: 'src/app.ts', content: 'code', hash: 'h' }];

    const openInEditor = vi.fn();
    const services = {
      artifacts: { openInEditor, listGenerated: vi.fn(() => []) },
      ledger: { getLedgerPath: vi.fn(() => '/ledger.jsonl'), append: vi.fn() },
    } as unknown as PipelineServices;

    await phase.run(host, ctx, services);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it('reports a non-zero generated dependency install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-deliver-'));
    try {
      fs.mkdirSync(path.join(root, 'generated'));
      fs.writeFileSync(path.join(root, 'generated', 'package.json'), '{}', 'utf-8');
      vi.spyOn(CrossPlatformShell, 'exec').mockResolvedValue({
        command: 'npm install',
        stdout: '',
        stderr: 'dependency resolution failed',
        exitCode: 1,
      });
      const eventBus = { emit: vi.fn() };

      const instructions = await detectRunInstructions({
        workspaceRoot: root,
        eventBus: eventBus as any,
        artifacts: { listGenerated: vi.fn(() => []) } as any,
      });

      expect(instructions).toContain('Dependency installation failed');
      expect(eventBus.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: {
          error: 'npm install exited with code 1',
          phase: 'deliver',
          recoverable: true,
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports generated dependency install launch failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-deliver-'));
    try {
      fs.mkdirSync(path.join(root, 'generated'));
      fs.writeFileSync(path.join(root, 'generated', 'package.json'), '{}', 'utf-8');
      vi.spyOn(CrossPlatformShell, 'exec').mockRejectedValue(new Error('shell unavailable'));
      const eventBus = { emit: vi.fn() };

      const instructions = await detectRunInstructions({
        workspaceRoot: root,
        eventBus: eventBus as any,
        artifacts: { listGenerated: vi.fn(() => []) } as any,
      });

      expect(instructions).toContain('shell unavailable');
      expect(eventBus.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: {
          error: 'Unable to install generated dependencies: shell unavailable',
          phase: 'deliver',
          recoverable: true,
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
