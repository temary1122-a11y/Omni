import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { test, expect, afterEach } from '../harness';
import { EventBus } from '../../src/core/EventBus';
import { ToolRegistry, isWithinBoundary, ToolDefinition, ToolContext } from '../../src/core/ToolRegistry';

const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  createdTmpDirs.length = 0;
});

function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-tool-')); createdTmpDirs.push(d); return d; }

const noopTool: ToolDefinition = { name: 'noop', description: 'does nothing', inputSchema: { type: 'object', properties: {}, required: [] } };

test('TR1 no boundary means any path allowed', () => {
  const root = tmp();
  expect(isWithinBoundary(root, undefined, 'a/b.txt') === true, 'without boundary any relative path is allowed');
  expect(isWithinBoundary(root, [], 'a/b.txt') === true, 'empty boundary means any path allowed');
});

test('TR2 boundary restricts writes to its directories', () => {
  const root = tmp();
  expect(isWithinBoundary(root, ['safe'], 'safe/ok.txt') === true, 'path inside boundary allowed');
  expect(isWithinBoundary(root, ['safe'], 'evil.txt') === false, 'path outside boundary blocked');
  expect(isWithinBoundary(root, ['safe'], 'safe/deep/x.txt') === true, 'nested path inside boundary allowed');
});

test('TR3 execute runs the registered executor and emits TOOL_RESULT', async () => {
  const bus = new EventBus();
  const reg = new ToolRegistry(bus);
  let ran = 0;
  reg.register('noop', noopTool, async () => { ran++; return { success: true, output: { ok: 1 }, durationMs: 0 }; });
  const results: any[] = [];
  bus.on('TOOL_RESULT', (e: any) => results.push(e.payload));
  const ctx: ToolContext = { workspaceRoot: tmp(), agentId: 'a', taskId: 't' };
  const res = await reg.execute('noop', {}, ctx);
  expect(ran === 1, 'executor should run exactly once');
  expect(res.success === true, 'result should be success');
  expect(results.length === 1 && results[0].success === true, 'TOOL_RESULT event should be emitted');
});

test('TR4 cacheable tool executes once and serves cached result', async () => {
  const reg = new ToolRegistry(new EventBus(), true);
  let calls = 0;
  reg.register('read_file', { name: 'read_file', description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    async (args) => { calls++; return { success: true, output: { n: calls }, durationMs: 0 }; });
  const ctx: ToolContext = { workspaceRoot: tmp(), agentId: 'a', taskId: 't' };
  await reg.execute('read_file', { path: 'x' }, ctx);
  await reg.execute('read_file', { path: 'x' }, ctx);
  expect(calls === 1, `cacheable tool should execute once and return cached result (calls=${calls})`);
});

test('TR5 tool honoring isWithinBoundary blocks writes outside boundary', async () => {
  const reg = new ToolRegistry(new EventBus());
  reg.register('write_file', { name: 'write_file', description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    async (args, context) => {
      if (!isWithinBoundary(context.workspaceRoot, context.boundary, args.path)) {
        return { success: false, error: 'blocked', durationMs: 0 };
      }
      return { success: true, output: args.path, durationMs: 0 };
    });
  const ctx: ToolContext = { workspaceRoot: tmp(), agentId: 'a', taskId: 't', boundary: ['safe'] };
  const blocked = await reg.execute('write_file', { path: 'evil.txt', content: 'x' }, ctx);
  expect(blocked.success === false, 'write outside boundary must be blocked');
  const ok = await reg.execute('write_file', { path: 'safe/ok.txt', content: 'x' }, ctx);
  expect(ok.success === true, 'write inside boundary allowed');
});

test('TR6 findRelevantTools ranks tools by query match', () => {
  const reg = new ToolRegistry(new EventBus());
  reg.register('read_file', { name: 'read_file', description: 'read a file', inputSchema: { type: 'object', properties: {}, required: [] } }, async () => ({ success: true, output: null, durationMs: 0 }));
  reg.register('web_search', { name: 'web_search', description: 'search the web', inputSchema: { type: 'object', properties: {}, required: [] } }, async () => ({ success: true, output: null, durationMs: 0 }));
  reg.register('write_file', { name: 'write_file', description: 'write a file', inputSchema: { type: 'object', properties: {}, required: [] } }, async () => ({ success: true, output: null, durationMs: 0 }));

  const relevant = reg.findRelevantTools('need to read a file and write updates');
  expect(relevant[0].name === 'read_file' || relevant[0].name === 'write_file', 'relevant tools should surface file ops first');
  expect(relevant.some((t) => t.name === 'write_file'), 'write_file should be present in shortlist');
});
