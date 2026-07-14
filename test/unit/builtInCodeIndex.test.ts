import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuiltInCodeIndex } from '../../src/core/BuiltInCodeIndex';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bci-'));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeFile(rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

describe('BuiltInCodeIndex', () => {
  it('is always available', async () => {
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    expect(await idx.isAvailable()).toBe(true);
  });

  it('finds a function symbol with 1-based line and inferred kind', async () => {
    writeFile('src/util.ts', '// header\nexport function greet() {\n  return 1;\n}\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const loc = await idx.findSymbol('greet');
    expect(loc).not.toBeNull();
    expect(loc!.line).toBe(2);
    expect(loc!.kind).toBe('function');
    expect(loc!.signature).toContain('function greet');
  });

  it('finds a class symbol and infers the class kind', async () => {
    writeFile('src/Thing.ts', 'class Thing {}\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const loc = await idx.findSymbol('Thing');
    expect(loc!.kind).toBe('class');
  });

  it('honors an explicit kind override', async () => {
    writeFile('src/Shape.ts', 'export interface Shape {}\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const loc = await idx.findSymbol('Shape', { kind: 'interface' });
    expect(loc!.kind).toBe('interface');
  });

  it('returns null for an unknown symbol', async () => {
    writeFile('src/a.ts', 'const x = 1;\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    expect(await idx.findSymbol('doesNotExist')).toBeNull();
  });

  it('ignores files inside node_modules and hidden directories', async () => {
    writeFile('node_modules/pkg/index.ts', 'export function hidden() {}\n');
    writeFile('.secret/x.ts', 'export function alsoHidden() {}\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    expect(await idx.findSymbol('hidden')).toBeNull();
    expect(await idx.findSymbol('alsoHidden')).toBeNull();
  });

  it('extracts imports and exports as dependency edges', async () => {
    const file = writeFile(
      'src/mod.ts',
      "import { a } from './a';\nconst b = require('./b');\nexport const c = 1;\n"
    );
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const deps = await idx.findDependencies(file);
    const targets = deps.imports.map((e) => e.target);
    expect(targets).toContain('./a');
    expect(targets).toContain('./b');
    expect(deps.exports.length).toBeGreaterThan(0);
    expect(deps.exports[0].kind).toBe('export');
  });

  it('accepts a workspace-relative path in findDependencies', async () => {
    writeFile('src/rel.ts', "import x from 'lodash';\n");
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const deps = await idx.findDependencies('src/rel.ts');
    expect(deps.imports[0].target).toBe('lodash');
  });

  it('returns empty dependencies for a missing file', async () => {
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const deps = await idx.findDependencies('nope.ts');
    expect(deps.imports).toEqual([]);
    expect(deps.exports).toEqual([]);
  });

  it('ranks semantic search results by token-hit score', async () => {
    writeFile('src/auth.ts', 'function login user password() {}\n');
    writeFile('src/other.ts', 'const login = true;\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const results = await idx.semanticSearch('login user password');
    expect(results.length).toBeGreaterThan(0);
    // The line matching all three tokens should score highest.
    expect(results[0].snippet).toContain('login user password');
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score - 0.0001);
  });

  it('returns no results for a blank query', async () => {
    writeFile('src/a.ts', 'const x = 1;\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    expect(await idx.semanticSearch('   ')).toEqual([]);
  });

  it('filters semantic search by language extension', async () => {
    writeFile('src/a.ts', 'widget rendering here\n');
    writeFile('src/b.py', 'widget rendering here\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const results = await idx.semanticSearch('widget', { language: 'py' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.file.endsWith('.py'))).toBe(true);
  });

  it('exposes search() as an alias of semanticSearch()', async () => {
    writeFile('src/a.ts', 'special marker token\n');
    const idx = new BuiltInCodeIndex({ workspaceRoot: root });
    const results = await idx.search('marker');
    expect(results.length).toBeGreaterThan(0);
  });
});
