import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { test, expect, afterEach } from '../harness';
import { EventBus } from '../../src/core/EventBus';
import { AgentRuntime } from '../../src/core/AgentRuntime';
import { ToolRegistry, ToolDefinition } from '../../src/core/ToolRegistry';
import { FakeModelRouter, FakeStep } from '../fixtures/FakeModelRouter';

const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  createdTmpDirs.length = 0;
});

function buildRuntime(tmpDir: string, fakeRouter: FakeModelRouter, tools: ToolDefinition[], executors: Record<string, any>) {
  const reg = new ToolRegistry(new EventBus());
  for (const t of tools) reg.register(t.name, t, executors[t.name]);
  return new AgentRuntime(new EventBus(), fakeRouter, reg, {
    agentId: 'researcher',
    tools,
    maxIterations: 3,
    systemPrompt: 'sys',
    workspaceRoot: tmpDir,
    apiKeys: {},
  });
}

const noopTool: ToolDefinition = { name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: {}, required: [] } };
const ctxPacket = { taskId: 't1', goal: 'g', workspaceSnapshot: { fileTree: [], hasPackageJson: false, techStack: [] } } as any;

test('AR1 loop terminates immediately when LLM returns no tool call', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rt-'));
  createdTmpDirs.push(tmpDir);
  const router = new FakeModelRouter([{ content: 'final answer' }]);
  const rt = buildRuntime(tmpDir, router, [], {});
  const manifest = await rt.run('goal', ctxPacket);
  expect(router.callCount === 1, `should call LLM exactly once (got ${router.callCount})`);
  expect(manifest.artifacts.length === 0, 'no tool calls means no written artifacts');
});

test('AR2 loop respects maxIterations cap with a repeating tool call', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rt-'));
  createdTmpDirs.push(tmpDir);
  const steps: FakeStep[] = [];
  for (let i = 0; i < 10; i++) steps.push({ toolCalls: [{ name: 'noop', arguments: {} }] });
  const router = new FakeModelRouter(steps);
  let noopRuns = 0;
  const rt = buildRuntime(tmpDir, router, [noopTool], { noop: async () => { noopRuns++; return { success: true, output: {}, durationMs: 0 }; } });
  const manifest = await rt.run('goal', ctxPacket);
  expect(router.callCount <= 3, `LLM must be called at most maxIterations (3), got ${router.callCount}`);
  expect(noopRuns <= 3, `tool must execute at most maxIterations (3), got ${noopRuns}`);
  expect(manifest.artifacts.length === 0, 'noop produces no artifacts');
});

test('AR3 text-based tool-call parsing executes a tool from JSON content', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rt-'));
  createdTmpDirs.push(tmpDir);
  const router = new FakeModelRouter([{ content: '{"tool":"noop","arguments":{"x":1}}' }]);
  let noopRuns = 0;
  const rt = buildRuntime(tmpDir, router, [noopTool], { noop: async (args: any) => { noopRuns++; expect(args.x === 1, 'parsed arguments should be passed to executor'); return { success: true, output: args, durationMs: 0 }; } });
  await rt.run('goal', ctxPacket);
  expect(noopRuns === 1, `text-embedded tool call should be parsed and executed once (got ${noopRuns})`);
});

test('AR4 write_file tool produces an artifact captured by the runtime', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rt-'));
  createdTmpDirs.push(tmpDir);
  const rel = 'out/note.txt';
  const content = 'hello from runtime';
  const router = new FakeModelRouter([{ toolCalls: [{ name: 'write_file', arguments: { path: rel, content } }] }]);
  const writeTool: ToolDefinition = { name: 'write_file', description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } };
  const rt = buildRuntime(tmpDir, router, [writeTool], {
    write_file: async (args: any, context: any) => {
      const full = path.join(context.workspaceRoot, args.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, args.content, 'utf-8');
      return { success: true, output: { path: args.path }, durationMs: 0 };
    },
  });
  const manifest = await rt.run('goal', ctxPacket);
  expect(manifest.artifacts.length >= 1, `write_file should produce an artifact (got ${manifest.artifacts.length})`);
  const written = manifest.artifacts.find((a: any) => a.filePath === rel);
  expect(!!written, 'artifact should record the written relative path');
  expect(written && written.content === content, 'artifact content should match what was written');
  expect(fs.existsSync(path.join(tmpDir, rel)), 'the file should actually exist on disk');
});

test('AR5 LLM failures reject instead of becoming successful final responses', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rt-'));
  createdTmpDirs.push(tmpDir);
  const router = new FakeModelRouter([]);
  (router as any).call = async () => {
    throw new Error('provider connection lost');
  };
  const rt = buildRuntime(tmpDir, router, [], {});

  let caught: unknown;
  try {
    await rt.run('goal', ctxPacket);
  } catch (error) {
    caught = error;
  }

  expect(caught instanceof Error, 'runtime should reject when the model router throws');
  expect(
    caught instanceof Error && caught.message.includes('AgentRuntime [researcher] LLM call failed: provider connection lost'),
    'runtime should preserve model failure context'
  );
});
