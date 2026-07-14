/**
 * BuiltInCodeIndex - zero-dependency, always-available code index.
 *
 * Unlike ProbeWrapper (which needs an external `probe` binary), this works out of
 * the box by walking the workspace and applying lightweight regex/ripgrep-style
 * matching. It returns precise file:line coordinates so the harness can pin-point
 * functions, classes and symbols for the agents.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CodeIndex, CodeIndexOptions, SymbolLocation, DependencyEdge, SearchResult } from './CodeIndex';

const IGNORE_DIRS = new Set(['node_modules', '.git', '.omniflow', 'dist', 'out', 'build', 'coverage', '.vscode']);

export class BuiltInCodeIndex implements CodeIndex {
  private readonly workspaceRoot: string;
  private readonly maxTokens: number;
  private fileCache: string[] | null = null;

  constructor(options: CodeIndexOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.maxTokens = options.maxTokens ?? 12_000;
  }

  async isAvailable(): Promise<boolean> {
    return true; // always available
  }

  private walk(): string[] {
    if (this.fileCache) return this.fileCache;
    const out: string[] = [];
    const stack = [this.workspaceRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          stack.push(full);
        } else if (/\.(ts|tsx|js|jsx|py|go|java|rb|rs|cpp|c|h|cs|php)$/i.test(e.name)) {
          out.push(full);
        }
      }
      if (out.length > 4000) break; // safety cap
    }
    this.fileCache = out;
    return out;
  }

  async findSymbol(name: string, options?: { kind?: string }): Promise<SymbolLocation | null> {
    const re = new RegExp(
      `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|class\\s+${name}\\b|(?:const|let|var|function)\\s+${name}\\s*=|(?:interface|type|enum)\\s+${name}\\b)`,
      'm'
    );
    const kindRe = options?.kind
      ? new RegExp(`(?:${options.kind})\\s+${name}\\b`, 'm')
      : null;
    for (const file of this.walk()) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]) || (kindRe && kindRe.test(lines[i]))) {
          return {
            file,
            line: i + 1,
            endLine: this.findSymbolEndLine(lines, i),
            signature: lines[i].trim(),
            kind: this.inferKind(lines[i], options?.kind),
          };
        }
      }
    }
    return null;
  }

  async findDependencies(filePath: string): Promise<{ imports: DependencyEdge[]; exports: DependencyEdge[] }> {
    const full = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
    const imports: DependencyEdge[] = [];
    const exports: DependencyEdge[] = [];
    if (!fs.existsSync(full)) return { imports, exports };
    const lines = fs.readFileSync(full, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ln = i + 1;
      const imp = line.match(/^import\s+.*?from\s+['"]([^'"]+)['"]/) || line.match(/require\(['"]([^'"]+)['"]\)/);
      if (imp) imports.push({ target: imp[1], source: full, kind: 'import', line: ln });
      if (/^\s*export\s+/.test(line) || /module\.exports\s*=/.test(line)) {
        exports.push({ target: full, source: full, kind: 'export', line: ln });
      }
    }
    return { imports, exports };
  }

  async semanticSearch(query: string, options?: { maxResults?: number; language?: string }): Promise<SearchResult[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (tokens.length === 0) return [];
    const limit = options?.maxResults ?? 10;
    const results: SearchResult[] = [];
    for (const file of this.walk()) {
      if (options?.language && !file.endsWith('.' + options.language)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const low = lines[i].toLowerCase();
        const hits = tokens.filter((t) => low.includes(t)).length;
        if (hits > 0) {
          results.push({
            file,
            startLine: i + 1,
            endLine: i + 1,
            snippet: lines[i].trim(),
            score: hits / tokens.length,
          });
        }
      }
      if (results.length > limit * 4) break;
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Convenience alias used by the code-search tool factory (createCodeSearchTools). */
  async search(query: string, opts?: { maxResults?: number; language?: string }): Promise<SearchResult[]> {
    return this.semanticSearch(query, opts);
  }

  private inferKind(snippet: string, explicit?: string): SymbolLocation['kind'] {
    if (explicit) return explicit as SymbolLocation['kind'];
    const s = snippet.trim();
    if (/^\s*(async\s+)?function\b/.test(s)) return 'function';
    if (/^\s*class\b/.test(s)) return 'class';
    if (/^\s*interface\b/.test(s)) return 'interface';
    if (/^\s*(export\s+)?(enum|const|let|var)\b/.test(s)) return 'constant';
    if (/^\s*(export\s+)?type\b/.test(s)) return 'type';
    return 'function';
  }

  private findSymbolEndLine(lines: string[], startIndex: number): number {
    let depth = 0;
    let sawOpenBrace = false;
    for (let i = startIndex; i < lines.length && i < startIndex + 250; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') {
          depth++;
          sawOpenBrace = true;
        } else if (ch === '}' && sawOpenBrace) {
          depth--;
          if (depth <= 0) return i + 1;
        }
      }
    }
    return startIndex + 1;
  }
}
