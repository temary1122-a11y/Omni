/**
 * NodeSandbox — In-process JavaScript execution sandbox.
 *
 * Provides a lightweight execution environment for LLM-generated code when
 * Docker is unavailable. Uses Node.js built-in `vm` module.
 *
 * SECURITY MODEL:
 * - NOT a crypto-hard sandbox (use Docker/isolated-vm for untrusted code)
 * - Designed for LLM-generated code that may be buggy, not malicious
 * - Enforces: timeout, workspace-bounded FS, no network, no process spawn
 * - Filters dangerous JS patterns before execution
 *
 * ARCHITECTURE:
 * - Sits BETWEEN Docker sandbox (preferred) and host execution (gated)
 * - Registered as `run_js` tool in ToolRegistry
 * - Coder/Planner/Researcher agents can use it for quick code execution
 */

import * as vm from 'vm';
import * as fs from 'fs';
import * as path from 'path';

export interface NodeSandboxOptions {
  /** Absolute path to the workspace root. All FS ops are scoped here. */
  workspaceRoot: string;
  /** Max execution time in ms. Default: 30000 (30s). */
  timeoutMs?: number;
  /** Max combined stdout+stderr bytes. Default: 65536 (64KB). */
  maxOutputBytes?: number;
  /** Whether to allow require of trusted built-in modules. Default: true. */
  allowBuiltins?: boolean;
  /** Additional variables exposed to the sandbox context. */
  injectVars?: Record<string, unknown>;
}

export interface NodeSandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  timedOut: boolean;
  /** If true, the sandbox refused to run the code (dangerous pattern). */
  refused: boolean;
  refuseReason?: string;
}

/**
 * Whitelist of Node.js built-in modules safe to expose.
 * Excludes: child_process, net, dgram, http*, cluster, process, os, repl, tls.
 */
const SAFE_BUILTINS = new Set([
  'assert', 'buffer', 'crypto', 'events', 'path', 'querystring',
  'stream', 'string_decoder', 'timers', 'url', 'util', 'zlib',
]);

export class NodeSandbox {
  private workspaceRoot: string;
  private timeoutMs: number;
  private maxOutputBytes: number;
  private allowBuiltins: boolean;
  private injectVars: Record<string, unknown>;

  constructor(options: NodeSandboxOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxOutputBytes = options.maxOutputBytes ?? 65536;
    this.allowBuiltins = options.allowBuiltins ?? true;
    this.injectVars = options.injectVars ?? {};
  }

  /**
   * Execute JS code in a sandboxed vm context.
   * Rejects dangerous patterns before execution.
   * Captures stdout/stderr, enforces timeout.
   */
  async run(code: string): Promise<NodeSandboxResult> {
    // ── Pre-flight safety check ──────────────────────────────────────────
    const safety = NodeSandbox.staticCheck(code);
    if (!safety.safe) {
      return {
        stdout: '', stderr: '', exitCode: 1, executionTimeMs: 0,
        timedOut: false, refused: true, refuseReason: safety.reason,
      };
    }

    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let totalOutput = 0;
    const outputCap = this.maxOutputBytes;

    const append = (target: 'out' | 'err', chunk: string): void => {
      if (totalOutput >= outputCap) {
        if (totalOutput === outputCap) {
          if (target === 'out') stdout += '\n[OUTPUT TRUNCATED]'; else stderr += '\n[OUTPUT TRUNCATED]';
          totalOutput++;
        }
        return;
      }
      const remaining = outputCap - totalOutput;
      const truncated = chunk.length > remaining ? chunk.slice(0, remaining) + '…' : chunk;
      if (target === 'out') stdout += truncated;
      else stderr += truncated;
      totalOutput += truncated.length;
    };

    // ── Restricted filesystem (workspace-bounded) ────────────────────────
    const wsResolve = (relative: string): string => {
      if (typeof relative !== 'string' || path.isAbsolute(relative)) {
        throw new Error(`Absolute paths are not allowed in sandbox: "${relative}"`);
      }
      const resolved = path.resolve(this.workspaceRoot, relative);
      if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
        throw new Error(`Path traversal blocked: "${relative}"`);
      }
      return resolved;
    };

    const restrictedFs = {
      readFileSync: (fp: string, enc?: string): string => {
        return fs.readFileSync(wsResolve(fp), (enc ?? 'utf-8') as BufferEncoding);
      },
      writeFileSync: (fp: string, data: string, enc?: string): void => {
        const abs = wsResolve(fp);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, data, (enc ?? 'utf-8') as BufferEncoding);
      },
      existsSync: (fp: string): boolean => {
        try { return fs.existsSync(wsResolve(fp)); } catch { return false; }
      },
      readdirSync: (dir: string): string[] => {
        return fs.readdirSync(wsResolve(dir));
      },
      statSync: (fp: string): fs.Stats => {
        return fs.statSync(wsResolve(fp));
      },
      mkdirSync: (dir: string, opts?: fs.MakeDirectoryOptions): void => {
        fs.mkdirSync(wsResolve(dir), opts);
      },
      unlinkSync: (fp: string): void => {
        fs.unlinkSync(wsResolve(fp));
      },
      readFile: (fp: string, enc?: string): Promise<string> => {
        return fs.promises.readFile(wsResolve(fp), (enc ?? 'utf-8') as BufferEncoding);
      },
      writeFile: (fp: string, data: string, enc?: string): Promise<void> => {
        const abs = wsResolve(fp);
        return fs.promises.mkdir(path.dirname(abs), { recursive: true })
          .then(() => fs.promises.writeFile(abs, data, (enc ?? 'utf-8') as BufferEncoding));
      },
    };

    // ── Sandbox require (only safe builtins + path) ──────────────────────
    const sandboxRequire = (name: string): unknown => {
      if (name === 'path') return path;
      if (name === 'fs') return restrictedFs;
      if (this.allowBuiltins && SAFE_BUILTINS.has(name)) {
        return require(name); // trusted Node.js builtins (buffer, crypto, etc.)
      }
      throw new Error(`require("${name}") is not allowed in sandbox. Allowed: ${Array.from(SAFE_BUILTINS).join(', ')}, fs (restricted), path`);
    };

    // ── Sandbox context ──────────────────────────────────────────────────
    const sandbox = {
      console: {
        log: (...args: unknown[]) => append('out', args.map(String).join(' ') + '\n'),
        info: (...args: unknown[]) => append('out', '[INFO] ' + args.map(String).join(' ') + '\n'),
        warn: (...args: unknown[]) => append('err', '[WARN] ' + args.map(String).join(' ') + '\n'),
        error: (...args: unknown[]) => append('err', '[ERROR] ' + args.map(String).join(' ') + '\n'),
      },
      require: sandboxRequire,
      setTimeout: (fn: any, ms?: number) => setTimeout(fn, Math.min(ms ?? 0, this.timeoutMs)),
      clearTimeout,
      setInterval: (fn: any, ms?: number) => setInterval(fn, Math.min(ms ?? 1000, 5000)),
      clearInterval,
      Promise,
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Intl,
      // Structured data
      ArrayBuffer,
      Uint8Array,
      // Buffer with size cap
      Buffer: {
        from: (data: string | any[], enc?: string) => {
          if (typeof data === 'string') {
            return Buffer.from(data.slice(0, 1024 * 1024), enc as BufferEncoding);
          }
          return Buffer.from(data as any);
        },
        alloc: (size: number) => Buffer.alloc(Math.min(size, 1024 * 1024)),
        concat: (chunks: Buffer[]) => Buffer.concat(chunks.map(c => c.slice(0, 65536))),
      },
      // Workspace-bound path helpers
      __workspaceRoot: this.workspaceRoot,
      ...this.injectVars,
    };

    try {
      const script = new vm.Script(code, {
        filename: 'sandbox.js',
      });

      const context = vm.createContext(sandbox);

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('SANDBOX_TIMEOUT')), this.timeoutMs);
      });

      // Suppress unhandled rejection when timeout promise loses the race
      // (e.g. vm.runInContext throws its own timeout before our setTimeout fires)
      timeoutPromise.catch(() => {});

      const result = await Promise.race([
        Promise.resolve(script.runInContext(context, {
          timeout: this.timeoutMs,
          breakOnSigint: true,
          displayErrors: true,
        })),
        timeoutPromise,
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);

      return {
        stdout,
        stderr,
        exitCode: 0,
        executionTimeMs: Date.now() - start,
        timedOut: false,
        refused: false,
      };
    } catch (error: any) {
      const msg: string = error?.message || String(error);
      const isTimeout = msg.includes('SANDBOX_TIMEOUT') || msg.includes('timed out') || msg.includes('Script execution timed out');

      if (isTimeout) {
        return {
          stdout, stderr: stderr || `Execution timed out after ${this.timeoutMs}ms`,
          exitCode: 124, executionTimeMs: this.timeoutMs,
          timedOut: true, refused: false,
        };
      }

      return {
        stdout,
        stderr: stderr ? stderr + '\n' + msg : msg,
        exitCode: 1,
        executionTimeMs: Date.now() - start,
        timedOut: false,
        refused: false,
      };
    }
  }

  /**
   * Static pre-flight check. Rejects code with known-dangerous patterns
   * BEFORE it enters the vm context. This is the first line of defense.
   */
  static staticCheck(code: string): { safe: boolean; reason?: string } {
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return { safe: false, reason: 'Empty code' };
    }
    if (code.length > 200_000) {
      return { safe: false, reason: 'Code exceeds 200KB limit' };
    }

    const dangerous: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /require\s*\(\s*['"](?:child_process|cluster|process|os|net|dgram|http2?|https?|tls|repl|v8|vm|worker_threads|perf_hooks|inspector|trace_events)['"]/, label: 'Dangerous require()' },
      { pattern: /process\.(?:exit|kill|abort|binding|dlopen|_rawDebug|umask|setuid|setgid|initgroups|chdir|cwd\s*=)/, label: 'process.* call' },
      { pattern: /\bimport\s*\(/, label: 'Dynamic import()' },
      { pattern: /\beval\s*\(/, label: 'eval()' },
      { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
      { pattern: /\bglobalThis\b/, label: 'globalThis access' },
      { pattern: /__proto__\s*\[/, label: '__proto__ mutation' },
      { pattern: /\bconstructor\s*\[/, label: 'constructor escape' },
      { pattern: /\bthis\.constructor\.constructor\b/, label: 'constructor chain escape' },
    ];

    for (const { pattern, label } of dangerous) {
      if (pattern.test(code)) {
        return { safe: false, reason: `Blocked: ${label} (pattern: ${pattern.source})` };
      }
    }

    return { safe: true };
  }
}
