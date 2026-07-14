import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { test, expect, afterEach } from '../harness';
import { EventBus } from '../../src/core/EventBus';
import {
  ToolRegistry,
  createDefaultTools,
  resolveWithinWorkspace,
  ToolContext,
} from '../../src/core/ToolRegistry';
import { SandboxTool } from '../../src/shell/SandboxTool';
import { SemanticEditor } from '../../src/shell/SemanticEditor';

const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  createdTmpDirs.length = 0;
});

function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-path-')); createdTmpDirs.push(d); return d; }

function makeRegistry(workspaceRoot: string): ToolRegistry {
  const bus = new EventBus();
  const reg = new ToolRegistry(bus, false);
  const sandbox = new SandboxTool({ workspaceRoot, eventBus: bus });
  const editor = new SemanticEditor(workspaceRoot);
  const { tools, executors } = createDefaultTools(sandbox, editor, workspaceRoot);
  for (const def of tools) reg.register(def.name, def, executors[def.name]);
  return reg;
}

test('PT1 resolveWithinWorkspace rejects traversal and absolute paths', () => {
  const root = '/workspace';
  expect(resolveWithinWorkspace(root, 'src/a.ts').ok === true, 'normal relative path allowed');
  expect(resolveWithinWorkspace(root, '../../etc/passwd').ok === false, 'parent traversal blocked');
  expect(resolveWithinWorkspace(root, '/etc/passwd').ok === false, 'absolute path blocked');
  expect(resolveWithinWorkspace(root, 'a/../../b').ok === false, 'embedded traversal escaping root blocked');
  expect(resolveWithinWorkspace(root, 'a/../b.ts').ok === true, 'traversal that stays inside root allowed');
  // sibling-prefix pitfall: /workspace-evil must not count as inside /workspace
  expect(resolveWithinWorkspace('/workspace', '../workspace-evil/x').ok === false, 'sibling with shared prefix blocked');
});

test('PT2 read_file cannot escape the workspace root', async () => {
  const root = tmp();
  const reg = makeRegistry(root);
  const ctx: ToolContext = { workspaceRoot: root, agentId: 'a', taskId: 't' };

  // A secret outside the workspace (simulates ~/.ssh/id_rsa, /etc/passwd, etc.)
  const outsideDir = tmp();
  const secret = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET', 'utf-8');
  const rel = path.relative(root, secret); // e.g. ../omni-path-xxxx/secret.txt

  const res = await reg.execute('read_file', { path: rel }, ctx);
  expect(res.success === false, 'read_file traversal must be blocked');
  expect(String(res.error).includes('traversal'), 'error should explain traversal block');

  const abs = await reg.execute('read_file', { path: secret }, ctx);
  expect(abs.success === false, 'read_file absolute path must be blocked');
});

test('PT3 read_file still works for in-workspace files', async () => {
  const root = tmp();
  const reg = makeRegistry(root);
  const ctx: ToolContext = { workspaceRoot: root, agentId: 'a', taskId: 't' };
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hi', 'utf-8');
  const res = await reg.execute('read_file', { path: 'hello.txt' }, ctx);
  expect(res.success === true, 'in-workspace read allowed');
  expect(res.output.content === 'hi', 'content returned');
});

test('PT4 write_file cannot escape the workspace root', async () => {
  const root = tmp();
  const outsideDir = tmp();
  const reg = makeRegistry(root);
  const ctx: ToolContext = { workspaceRoot: root, agentId: 'a', taskId: 't' };
  const target = path.join(outsideDir, 'pwned.txt');
  const rel = path.relative(root, target);

  const res = await reg.execute('write_file', { path: rel, content: 'x' }, ctx);
  expect(res.success === false, 'write_file traversal must be blocked');
  expect(fs.existsSync(target) === false, 'file outside workspace must not be created');
});

test('PT5 SandboxTool.executeWithFallback refuses destructive host commands', async () => {
  const root = tmp();
  // The static fallback only runs on the host when Docker is unavailable; when a
  // daemon is reachable it throws instead. Only assert the safety gate when the
  // fallback path is actually exercised.
  const dockerUp = await SandboxTool.isDockerAvailable();
  if (dockerUp) return;
  const res = await SandboxTool.executeWithFallback({ command: 'rm -rf /' }, root);
  expect(res.exitCode === 1, 'destructive command must be refused');
  expect(String(res.stderr).toLowerCase().includes('destructive'), 'refusal reason surfaced');
});
