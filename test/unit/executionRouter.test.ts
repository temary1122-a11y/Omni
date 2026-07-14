import { describe, expect, it, vi } from 'vitest';
import { ExecutionRouter } from '../../src/core/ExecutionRouter';
import { ClineConfigurationError } from '../../src/agents/ClineAgentWrapper';
import type { ArtifactManifest, HandoffContract } from '../../shared/types';

function manifest(subtaskId: string, note: string): ArtifactManifest {
  return { artifacts: [], subtaskId, completedAt: 0, selfVerification: note };
}

function contract(overrides: Partial<HandoffContract> = {}): HandoffContract {
  return {
    subtaskId: 's1',
    agentRole: 'coder',
    description: overrides.description ?? '',
    successCriteria: [],
    artifactTargets: overrides.artifactTargets ?? [],
    contextPacket: {
      taskId: 't1',
      goal: 'do the thing',
      workspaceSnapshot: {} as any,
      ...(overrides.contextPacket as any),
    } as any,
    ...overrides,
  } as HandoffContract;
}

function makeRouter(opts: {
  clineLoaded?: boolean;
  clineExecute?: (...a: any[]) => Promise<ArtifactManifest>;
  legacyExecute?: (...a: any[]) => Promise<ArtifactManifest>;
}) {
  const cline = {
    isLoaded: vi.fn(() => opts.clineLoaded ?? true),
    execute: vi.fn(opts.clineExecute ?? (async () => manifest('s1', 'cline'))),
  };
  const legacy = {
    execute: vi.fn(opts.legacyExecute ?? (async () => manifest('s1', 'legacy'))),
  };
  const router = new ExecutionRouter({ cline: cline as any, legacy: legacy as any });
  return { router, cline, legacy };
}

describe('ExecutionRouter backend selection', () => {
  it('respects an explicit "legacy" backend even for build-like work', async () => {
    const { router, cline, legacy } = makeRouter({});
    const c = contract({
      artifactTargets: [{ filePath: 'a.ts', contentType: 'code' }],
      contextPacket: { executionBackend: 'legacy' } as any,
    });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('legacy');
    expect(legacy.execute).toHaveBeenCalledOnce();
    expect(cline.execute).not.toHaveBeenCalled();
  });

  it('respects an explicit "cline" backend', async () => {
    const { router, cline } = makeRouter({});
    const c = contract({ contextPacket: { executionBackend: 'cline' } as any });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('cline');
    expect(cline.execute).toHaveBeenCalledOnce();
  });

  it('uses legacy when the Cline SDK is not loaded', async () => {
    const { router, legacy, cline } = makeRouter({ clineLoaded: false });
    const c = contract({ artifactTargets: [{ filePath: 'a.ts', contentType: 'code' }] });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('legacy');
    expect(legacy.execute).toHaveBeenCalledOnce();
    expect(cline.execute).not.toHaveBeenCalled();
  });

  it('routes build-like work (code artifact target) to cline', async () => {
    const { router, cline } = makeRouter({});
    const c = contract({ artifactTargets: [{ filePath: 'a.ts', contentType: 'code' }] });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('cline');
    expect(cline.execute).toHaveBeenCalledOnce();
  });

  it('routes build-like work (build verb in description) to cline', async () => {
    const { router, cline } = makeRouter({});
    const c = contract({ description: 'implement the parser' });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('cline');
    expect(cline.execute).toHaveBeenCalledOnce();
  });

  it('routes non-build work to legacy', async () => {
    const { router, legacy, cline } = makeRouter({});
    const c = contract({ description: 'summarize the findings', artifactTargets: [{ filePath: 'a.md', contentType: 'doc' }] });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('legacy');
    expect(legacy.execute).toHaveBeenCalledOnce();
    expect(cline.execute).not.toHaveBeenCalled();
  });
});

describe('ExecutionRouter fallback', () => {
  it('falls back to legacy when Cline throws a configuration error', async () => {
    const { router, legacy } = makeRouter({
      clineExecute: async () => { throw new ClineConfigurationError('missing key'); },
    });
    const c = contract({ contextPacket: { executionBackend: 'cline' } as any });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('legacy');
    expect(legacy.execute).toHaveBeenCalledOnce();
  });

  it('falls back to legacy on any unexpected Cline error', async () => {
    const { router, legacy } = makeRouter({
      clineExecute: async () => { throw new Error('boom'); },
    });
    const c = contract({ contextPacket: { executionBackend: 'cline' } as any });
    const res = await router.execute(c, '/ws');
    expect(res.selfVerification).toBe('legacy');
    expect(legacy.execute).toHaveBeenCalledOnce();
  });

  it('passes the goal and contract through to the cline backend', async () => {
    const { router, cline } = makeRouter({});
    const c = contract({ contextPacket: { executionBackend: 'cline', goal: 'ship it' } as any });
    await router.execute(c, '/ws');
    expect(cline.execute).toHaveBeenCalledWith('ship it', c);
  });
});
