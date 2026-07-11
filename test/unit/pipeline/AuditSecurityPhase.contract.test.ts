import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuditSecurityPhase } from '../../../src/pipeline/phases/AuditSecurityPhase';
import type { PipelineContext, PipelineHost, PipelineServices, PhaseOutcome } from '../../../src/pipeline/types';
import type { HandoffContract } from '../../../src/shared/types';
import type { SecurityReport } from '../../../src/shared/types';

// Mock the types we need
describe('AuditSecurityPhase contract', () => {
  let phase: AuditSecurityPhase;
  let ctx: PipelineContext;
  let host: PipelineHost;
  let services: PipelineServices;

  beforeEach(() => {
    phase = new AuditSecurityPhase();

    ctx = {
      taskId: 'task-123',
      rawGoal: 'test goal',
      workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      goalPacket: {
        taskId: 'task-123',
        intent: 'build',
        complexity: 'low',
        goal: 'test goal',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
      tier: 'LOW',
      phases: [], // will be set in tests
      artifacts: [],
      contextPacket: {
        taskId: 'task-123',
        goal: 'test goal',
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
        planSummary: '',
        researchSummary: undefined,
        researchReport: undefined,
        bounceContext: undefined,
        agentsMd: undefined,
        omniMd: undefined,
        plannedStack: undefined,
        memoryContext: undefined,
      },
      compassPath: undefined,
    };

    host = {
      workspaceRoot: '/workspace',
      emitPhaseLifecycle: vi.fn(),
      transitionTo: vi.fn(),
      setAgent: vi.fn(),
      transitionPhase: vi.fn(),
      runPhaseSafely: vi.fn(async (fn) => fn()),
      requestApiKeyPrompt: vi.fn(),
      askClarifyingQuestions: vi.fn(async () => []),
      refineGoal: vi.fn((g) => g),
      requestApproval: vi.fn(async () => ({ approved: true, feedback: '', requestId: 'req-1' })),
      emitArtifact: vi.fn(),
      getElapsedMs: () => 100,
      scanWorkspace: vi.fn(async () => ({ fileTree: ['src/'], hasPackageJson: true, hasReadme: false, techStack: ['typescript'] })),
      draftProjectDocs: vi.fn(async () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' })),
      readProjectDocs: () => ({ agentsMd: '# AGENTS.md', omniMd: '# OMNI.md' }),
    };

    services = {
      auditor: {
        execute: vi.fn(),
      },
      security: {
        execute: vi.fn(),
      },
      memory: {
        setSecurityReport: vi.fn(),
      },
      clarifier: { execute: vi.fn() },
      roleSelector: { select: vi.fn() },
      modelIndexer: undefined,
      router: undefined,
    } as unknown as PipelineServices;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('canRun', () => {
    it('returns true when phases include audit', () => {
      ctx.phases = ['audit'];
      expect(phase.canRun(ctx)).toBe(true);
    });

    it('returns true when phases include security', () => {
      ctx.phases = ['security'];
      expect(phase.canRun(ctx)).toBe(true);
    });

    it('returns false when phases include neither', () => {
      ctx.phases = ['intake', 'research'];
      expect(phase.canRun(ctx)).toBe(false);
    });
  });

  describe('run', () => {
    it('sets boundary for auditor to .omniflow/audit when audit phase is run', async () => {
      ctx.phases = ['audit'];
      const auditContract: HandoffContract = {
        subtaskId: `audit_${ctx.taskId}`,
        agentRole: 'auditor',
        successCriteria: ['Audit complete'],
        artifactTargets: [],
        contextPacket: ctx.contextPacket,
        compassPath: ctx.compassPath,
      };
      // We don't need to mock the actual execution, just check that the contract passed to runPhaseSafely has the boundary
      const runPhaseSafelyMock = host.runPhaseSafely as vi.Mock;
      runPhaseSafelyMock.mockImplementation(async (fn) => {
        // The function passed to runPhaseSafely is the one that calls services.auditor.execute
        // We can't easily capture the argument without mocking the service, but we can check the call to services.auditor.execute
        // Instead, we'll mock the service and check the argument it receives.
        await fn();
      });

      await phase.run(host, ctx, services);

      // Check that services.auditor.execute was called with a contract that has boundary ['.omniflow/audit']
      expect(services.auditor.execute).toHaveBeenCalled();
      const auditCallArg = (services.auditor.execute as mock.Mock).mock.calls[0][0];
      expect(auditCallArg).toHaveProperty('boundary');
      expect(auditCallArg.boundary).toEqual(['.omniflow/audit']);
    });

    it('sets boundary for security to .omniflow/security when security phase is run', async () => {
      ctx.phases = ['security'];
      const secExecContract: HandoffContract = {
        subtaskId: `sec_${ctx.taskId}`,
        agentRole: 'security',
        successCriteria: ['Audit complete'],
        artifactTargets: [],
        contextPacket: ctx.contextPacket,
        compassPath: ctx.compassPath,
        boundary: ['.omniflow/security'], // expected
      };
      // Mock the security.execute to return a mock artifact manifest
      const mockManifest = {
        artifacts: [
          {
            filePath: '.omniflow/security/task-123/security-report.json',
            content: JSON.stringify({
              taskId: 'task-123',
              findings: [],
              passed: true,
            }),
            hash: 'hash',
          },
        ],
        subtaskId: 'sec_123',
        completedAt: Date.now(),
        selfVerification: 'Security scan completed',
      };
      services.security.execute.mockResolvedValue(mockManifest);

      await phase.run(host, ctx, services);

      // Check that services.security.execute was called with a contract that has boundary ['.omniflow/security']
      expect(services.security.execute).toHaveBeenCalled();
      const secCallArg = (services.security.execute as mock.Mock).mock.calls[0][0];
      expect(secCallArg).toHaveProperty('boundary');
      expect(secCallArg.boundary).toEqual(['.omniflow/security']);

      // Also check that services.memory.setSecurityReport was called with the parsed report
      expect(services.memory.setSecurityReport).toHaveBeenCalled();
      const reportArg = (services.memory.setSecurityReport as mock.Mock).mock.calls[0][0];
      expect(reportArg).toHaveProperty('taskId', 'task-123');
      expect(reportArg).toHaveProperty('findings');
      expect(reportArg).toHaveProperty('passed', true);
    });

it('does not call security.execute if security phase is not in phases', async () => {
  ctx.phases = ['audit']; // no security
  await phase.run(host, ctx, services);
  expect(services.security.execute).not.toHaveBeenCalled();
});

it('does not call auditor.execute if audit phase is not in phases', async () => {
    ctx.phases = ['security']; // no audit
    services.security.execute.mockResolvedValue({
      artifacts: [{ filePath: 'test.json', content: JSON.stringify({ taskId: 'task-123', findings: [], passed: true }) }],
      subtaskId: 'sec_task-123',
      completedAt: Date.now(),
    });
    await phase.run(host, ctx, services);
    expect(services.auditor.execute).not.toHaveBeenCalled();
  });
  });
});