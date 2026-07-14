import { vi } from 'vitest';
import { test, expect } from '../harness';

// Force the Docker/harness init to fail so SandboxTool takes its local-execution
// path deterministically (no Docker required in CI).
vi.mock('../../src/shell/OmniHarness', () => ({
  OmniHarness: class {
    constructor() {}
    async initialize() {
      throw new Error('docker unavailable (test)');
    }
    async executeCommand() {
      throw new Error('should not run in container during this test');
    }
    async cleanup() {}
    static summarizeForLLM() {
      return '';
    }
  },
}));

// Stub the host shell so a "permitted" command does not actually run anything.
vi.mock('../../src/shell/CrossPlatformShell', () => ({
  CrossPlatformShell: {
    exec: vi.fn(async (command: string) => ({
      stdout: 'ran:' + command,
      stderr: '',
      exitCode: 0,
      command,
    })),
  },
}));

import { SandboxTool } from '../../src/shell/SandboxTool';
import { EventBus } from '../../src/core/EventBus';

function makeTool(allowLocalExecution: boolean) {
  const eventBus = new EventBus();
  const events: Array<{ type: string; payload: unknown }> = [];
  eventBus.on('SANDBOX_EVENT', (e) => events.push(e as never));
  const tool = new SandboxTool({ workspaceRoot: process.cwd(), eventBus, allowLocalExecution });
  return { tool, events };
}

test('ST1 blocks host execution when Docker is down and opt-in is OFF', async () => {
  const { tool, events } = makeTool(false);
  const res = await tool.executeInSandbox({ command: 'npm install' });
  expect(res.exitCode === 1, 'refused command should have non-zero exit');
  expect(/refusing to run/i.test(res.stderr), 'stderr should explain the refusal');
  expect(events.length > 0, 'a SANDBOX_EVENT should be emitted');
});

test('ST2 permits a safe command on host when opt-in is ON', async () => {
  const { tool } = makeTool(true);
  const res = await tool.executeInSandbox({ command: 'npm run build' });
  expect(res.exitCode === 0, 'permitted safe command should run');
  expect(res.stdout === 'ran:npm run build', 'host shell should have executed the command');
});

test('ST3 blocks destructive commands even when opt-in is ON', async () => {
  const { tool } = makeTool(true);
  const res = await tool.executeInSandbox({ command: 'rm -rf /' });
  expect(res.exitCode === 1, 'destructive command must be refused');
  expect(/destructive/i.test(res.stderr), 'stderr should flag the destructive command');
});

test('ST4 setAllowLocalExecution toggles the gate at runtime', async () => {
  const { tool } = makeTool(false);
  let res = await tool.executeInSandbox({ command: 'echo hi' });
  expect(res.exitCode === 1, 'blocked before opt-in');
  tool.setAllowLocalExecution(true);
  res = await tool.executeInSandbox({ command: 'echo hi' });
  expect(res.exitCode === 0, 'permitted after opt-in');
});
