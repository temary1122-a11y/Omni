import { EventBus } from './EventBus';
import type { IpcMessage } from '../../shared/types';
import { SandboxTool } from '../shell/SandboxTool';
import { SemanticEditor } from '../shell/SemanticEditor';
import { ResultCache } from './ResultCache';
import type { SandboxCommandOptions, SandboxCommandResult } from '../../shared/types/sandbox';
import type { SemanticEditInput, SemanticEditResult } from '../../shared/types';
import type { MemoryFacade } from '../memory/MemoryFacade';
import type { ArtifactManager } from '../artifacts/ArtifactManager';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolContext {
  workspaceRoot: string;
  agentId: string;
  taskId: string;
  /** Write-boundary: relative paths/dirs this tool may write to. Enforced in write executors. */
  boundary?: string[];
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  durationMs: number;
}

/**
 * Returns true when `relPath` is allowed given `boundary` (list of relative
 * file/dir paths). A write is allowed when the resolved target equals a boundary
 * entry or lives inside a boundary directory. Empty/undefined boundary means
 * "no restriction" (legacy behavior).
 */
export function isWithinBoundary(workspaceRoot: string, boundary: string[] | undefined, relPath: string): boolean {
  if (!boundary || boundary.length === 0) return true;
  const path = require('path');
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath);
  for (const b of boundary) {
    const bb = path.resolve(root, b);
    // exact file match, or anything inside the boundary directory
    if (target === bb) return true;
    if (target.startsWith(bb + path.sep)) return true;
    // A single-FILE boundary allows writing anywhere in the workspace root tree.
    if (path.extname(b).length > 0) {
      if (target === root || target.startsWith(root + path.sep)) return true;
    }
  }
  return false;
}

/**
 * Resolve a caller-supplied (relative) path against the workspace root and
 * confirm it stays inside that root. Rejects absolute paths and `..` traversal
 * so LLM-generated tool calls cannot read/write files outside the workspace
 * (e.g. `/etc/passwd`, `../../.ssh/id_rsa`).
 *
 * The containment test compares the resolved target against the resolved root
 * with a trailing separator, avoiding the sibling-prefix pitfall where
 * `/workspace-evil` would falsely match a `/workspace` root.
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  relPath: string
): { ok: true; fullPath: string } | { ok: false; error: string } {
  const path = require('path');
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, error: 'A file path is required.' };
  }
  if (path.isAbsolute(relPath)) {
    return { ok: false, error: `Absolute paths are not allowed: '${relPath}'. Use a path relative to the workspace root.` };
  }
  const root = path.resolve(workspaceRoot);
  const fullPath = path.resolve(root, relPath);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    return { ok: false, error: `Path '${relPath}' resolves outside the workspace root. Path traversal is not allowed.` };
  }
  return { ok: true, fullPath };
}

export type ToolExecutor = (
  args: any,
  context: ToolContext
) => Promise<ToolResult>;

export class ToolRegistry {
  private tools: Map<string, { definition: ToolDefinition; executor: ToolExecutor }> = new Map();
  private eventBus: EventBus;
  private resultCache: ResultCache;
  private enableCaching: boolean = true;

  constructor(eventBus: EventBus, enableCaching: boolean = true) {
    this.eventBus = eventBus;
    this.enableCaching = enableCaching;
    this.resultCache = new ResultCache({
      maxSize: 1000,
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      enableFileInvalidation: true,
      enableStats: true,
    });
  }

  register(name: string, definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(name, { definition, executor });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  private shouldCacheTool(toolName: string): boolean {
    // Cache read-only tools that are expensive
    const cacheableTools = [
      'read_file',
      'probe_search', 'probe_find_symbol', 'probe_find_dependencies',
      'code_search', 'code_find_symbol', 'code_find_dependencies',
      'artifact_find', 'semantic_search', 'recall_skill',
      'help', 'get_tool_schema',
    ];
    return cacheableTools.includes(toolName);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  async execute(name: string, args: any, context: ToolContext): Promise<ToolResult> {
    // Stable id shared by the CALL + RESULT pair so the UI can match them
    // into a single card (previously the timestamps drifted and the result got
    // orphaned, while a second emitter duplicated the card).
    const callId = crypto.randomUUID();
    const emit = (result: ToolResult): ToolResult => {
      this.emitToolCall(context, name, args, Date.now(), callId);
      this.emitToolResult(context, name, result, callId);
      return result;
    };

    const tool = this.tools.get(name);
    if (!tool) {
      return emit({
        success: false,
        error: `Unknown tool: ${name}`,
        durationMs: 0,
      });
    }

    // Check cache if enabled
    if (this.enableCaching && this.shouldCacheTool(name)) {
      const cached = this.resultCache.get(name, args);
      if (cached) {
        return emit({
          ...cached,
          durationMs: 0, // Cached results are instant
        });
      }
    }

    const startTime = Date.now();
    this.emitToolCall(context, name, args, startTime, callId);

    try {
      const result = await tool.executor(args, context);
      const durationMs = Date.now() - startTime;
      const toolResult: ToolResult = { ...result, durationMs };

      // Cache result if enabled and successful
      if (this.enableCaching && this.shouldCacheTool(name) && result.success) {
        this.resultCache.set(name, args, result);
      }

      // Invalidate cache for file-related tools
      if (name === 'write_file' && result.success) {
        this.resultCache.invalidateByFile(args.path);
      }

      this.emitToolResult(context, name, toolResult, callId);
      return toolResult;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorResult: ToolResult = {
        success: false,
        error: error.message || 'Tool execution failed',
        durationMs,
      };
      this.emitToolResult(context, name, errorResult, callId);
      return errorResult;
    }
  }

  toOpenAITools(): any[] {
    return this.list().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private emitToolCall(context: ToolContext, tool: string, args: any, timestamp: number, callId: string): void {
    const event = {
      type: 'TOOL_CALL' as const,
      payload: {
        agentId: context.agentId as any,
        toolName: tool,
        args,
        timestamp,
        callId,
      },
    };
    this.eventBus.emit(event as IpcMessage);
  }

  private emitToolResult(context: ToolContext, tool: string, result: ToolResult, callId: string): void {
    const event = {
      type: 'TOOL_RESULT' as const,
      payload: {
        agentId: context.agentId as any,
        toolName: tool,
        success: result.success,
        output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
        error: result.error,
        timestamp: Date.now(),
        callId,
      },
    };
    this.eventBus.emit(event as IpcMessage);
  }

  // Cache management methods
  getCacheStats() {
    return this.resultCache.getStats();
  }

  clearCache(): void {
    this.resultCache.clear();
  }

  invalidateCache(toolName?: string, args?: any): void {
    this.resultCache.invalidate(toolName, args);
  }

  setCacheEnabled(enabled: boolean): void {
    this.enableCaching = enabled;
  }

  isCacheEnabled(): boolean {
    return this.enableCaching;
  }

  pruneExpiredCache(): number {
    return this.resultCache.pruneExpired();
  }
}

export function createDefaultTools(
  sandboxTool: SandboxTool,
  semanticEditor: SemanticEditor,
  workspaceRoot: string
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  // bash tool
  const bashTool: ToolDefinition = {
    name: 'bash',
    description: 'Execute a shell command in the sandbox. Use for running tests, building, linting, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  };

  executors['bash'] = async (args, context) => {
    const options: SandboxCommandOptions = {
      command: args.command,
      cwd: args.cwd || context.workspaceRoot,
    };
    const result: SandboxCommandResult = await sandboxTool.executeInSandbox(options);
    return {
      success: result.exitCode === 0,
      output: result.stdout,
      error: result.stderr || (result.exitCode !== 0 ? `Exit code: ${result.exitCode}` : undefined),
      durationMs: result.executionTime,
    };
  };

  // write_file tool
  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  };

  executors['write_file'] = async (args, context) => {
    const fs = require('fs');
    const path = require('path');
    // Ensure the resolved path is actually within workspaceRoot (rejects
    // absolute paths and `..` traversal) before any boundary/write logic.
    const resolved = resolveWithinWorkspace(context.workspaceRoot, args.path);
    if (!resolved.ok) {
      return { success: false, error: `Write blocked: ${resolved.error}`, durationMs: 0 };
    }
    const fullPath = resolved.fullPath;
    if (!isWithinBoundary(context.workspaceRoot, context.boundary, args.path)) {
      return {
        success: false,
        error: `Write blocked by boundary: '${args.path}' is outside the allowed write paths [${context.boundary?.join(', ') || ''}].`,
        durationMs: 0,
      };
    }

    try {
      // Ensure parent directories exist — otherwise writing into a nested
      // path (e.g. .omniflow/tasks/t1/report.json) fails with ENOENT.
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content, 'utf-8');
      return {
        success: true,
        output: { path: args.path, bytes: Buffer.byteLength(args.content, 'utf-8') },
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        durationMs: 0,
      };
    }
  };

  // read_file tool
  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read the content of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
      },
      required: ['path'],
    },
  };

  executors['read_file'] = async (args, context) => {
    const fs = require('fs');
    const resolved = resolveWithinWorkspace(context.workspaceRoot, args.path);
    if (!resolved.ok) {
      return { success: false, error: `Read blocked: ${resolved.error}`, durationMs: 0 };
    }
    const fullPath = resolved.fullPath;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return {
        success: true,
        output: { path: args.path, content },
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        durationMs: 0,
      };
    }
  };

  // replace_symbol tool
  const replaceSymbolTool: ToolDefinition = {
    name: 'replace_symbol',
    description: 'Replace a symbol (function, class, method, etc.) in a file using semantic resolution. More precise than line-based edits.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path from workspace root' },
        symbolName: { type: 'string', description: 'Symbol name to replace (e.g., function or class name)' },
        newCode: { type: 'string', description: 'New code to replace the symbol with' },
      },
      required: ['file', 'symbolName', 'newCode'],
    },
  };

  executors['replace_symbol'] = async (args, context) => {
    const input: SemanticEditInput = {
      file: args.file,
      symbolName: args.symbolName,
      newCode: args.newCode,
      action: 'replace_symbol',
    };
    const resolvedEdit = resolveWithinWorkspace(context.workspaceRoot, args.file);
    if (!resolvedEdit.ok) {
      return { success: false, error: `Edit blocked: ${resolvedEdit.error}`, durationMs: 0 };
    }
    if (!isWithinBoundary(context.workspaceRoot, context.boundary, args.file)) {
      return {
        success: false,
        error: `Edit blocked by boundary: '${args.file}' is outside the allowed write paths [${context.boundary?.join(', ') || ''}].`,
        durationMs: 0,
      };
    }
    const result: SemanticEditResult = await semanticEditor.apply(input);
    return {
      success: result.success,
      output: result,
      error: result.error,
      durationMs: 0,
    };
  };

  return {
    tools: [bashTool, writeFileTool, readFileTool, replaceSymbolTool],
    executors,
  };
}

/**
 * Phase 2.1: Vertical Code Indexing tools.
 *
 * Creates Probe-backed code search tools that can be registered
 * alongside existing default tools without modifying them.
 */
export function createCodeSearchTools(
  probeWrapper: { search: (query: string) => Promise<any[]>; findSymbol: (name: string) => Promise<any>; findDependencies: (file: string) => Promise<any> },
  workspaceRoot: string
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  // probe_search tool
  const probeSearchTool: ToolDefinition = {
    name: 'probe_search',
    description: 'AST-aware semantic code search. Use boolean queries (AND, OR, NOT, "exact phrase"). Returns ranked code blocks with file/line context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query with optional Elasticsearch-style syntax' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 10)' },
        language: { type: 'string', description: 'Optional language filter, e.g. typescript, python, rust' },
      },
      required: ['query'],
    },
  };

  executors['probe_search'] = async (args, context) => {
    try {
      const results = await probeWrapper.search(args.query);
      const max = typeof args.maxResults === 'number' ? args.maxResults : 10;
      const items = Array.isArray(results) ? results.slice(0, max) : [];
      return {
        success: true,
        output: { query: args.query, results: items, total: items.length },
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'probe_search failed',
        durationMs: 0,
      };
    }
  };

  // probe_find_symbol tool
  const probeFindSymbolTool: ToolDefinition = {
    name: 'probe_find_symbol',
      description: 'Find a symbol (function, class, method, variable) by name. Returns file, line, endLine, and signature.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to locate' },
        kind: { type: 'string', description: 'Optional symbol kind: function, class, interface, method, variable, constant, enum, type' },
      },
      required: ['name'],
    },
  };

  executors['probe_find_symbol'] = async (args, context) => {
    try {
      const result = await probeWrapper.findSymbol(args.name);
      if (!result) {
        return {
          success: false,
          output: null,
          error: `Symbol not found: ${args.name}`,
          durationMs: 0,
        };
      }
      return {
        success: true,
        output: result,
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'probe_find_symbol failed',
        durationMs: 0,
      };
    }
  };

  // probe_find_dependencies tool
  const probeFindDependenciesTool: ToolDefinition = {
    name: 'probe_find_dependencies',
    description: 'Find imports and exports for a given file. Returns dependency edges with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path from workspace root' },
      },
      required: ['file'],
    },
  };

  executors['probe_find_dependencies'] = async (args, context) => {
    try {
      const result = await probeWrapper.findDependencies(args.file);
      return {
        success: true,
        output: result,
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'probe_find_dependencies failed',
        durationMs: 0,
      };
    }
  };

  return {
    tools: [probeSearchTool, probeFindSymbolTool, probeFindDependenciesTool],
    executors,
  };
}

/**
 * Phase 3 Integration: Code search tools with code_ prefix to avoid collisions.
 * Re-exports probe tools with standardised names.
 */
export function createCodeSearchAliasTools(
  probeWrapper: { search: (query: string) => Promise<any[]>; findSymbol: (name: string) => Promise<any>; findDependencies: (file: string) => Promise<any> }
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const base = createCodeSearchTools(probeWrapper, '');
  const aliasTools: ToolDefinition[] = base.tools.map((t) => ({
    ...t,
    name: t.name.replace('probe_', 'code_'),
  }));
  const aliasExecutors: Record<string, ToolExecutor> = {};
  for (const [k, v] of Object.entries(base.executors)) {
    aliasExecutors[k.replace('probe_', 'code_')] = v;
  }
  return { tools: aliasTools, executors: aliasExecutors };
}

/**
 * Phase 3 Integration: Memory tools (recall_skill, semantic_search).
 * Wraps MemoryFacade behind tool interfaces so the LLM can call them.
 */
export function createMemoryTools(
  memory: MemoryFacade
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  // recall_skill
  const recallSkillTool: ToolDefinition = {
    name: 'recall_skill',
    description: 'Find the best matching skill/pattern from procedural memory for a query. Use before implementing complex workflows to check if a similar pattern was already solved.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Description of the task or pattern to find' },
        category: { type: 'string', description: 'Optional category: tool | pattern | workflow | strategy' },
      },
      required: ['query'],
    },
  };

  executors['recall_skill'] = async (args) => {
    try {
      const match = memory.findBestSkill(args.query, args.category);
      if (!match) {
        return { success: true, output: { found: false, skill: null }, durationMs: 0 };
      }
      return {
        success: true,
        output: {
          found: true,
          skill: {
            id: match.skill.id,
            name: match.skill.name,
            description: match.skill.description,
            category: match.skill.category,
            successRate: match.skill.successRate,
          },
          score: match.score,
          reason: match.reason,
        },
        durationMs: 0,
      };
    } catch (error: any) {
      return { success: false, error: error.message, durationMs: 0 };
    }
  };

  // semantic_search
  const semanticSearchTool: ToolDefinition = {
    name: 'semantic_search',
    description: 'Search the semantic knowledge graph for symbols, concepts, or entities related to a query. Returns file locations and relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concepts or symbols to search for' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['query'],
    },
  };

  executors['semantic_search'] = async (args) => {
    try {
      const nodes = memory.semanticSearch(args.query, args.limit ?? 5);
      return {
        success: true,
        output: { query: args.query, results: nodes.map((n) => ({ label: n.label, type: n.type, properties: n.properties })), total: nodes.length },
        durationMs: 0,
      };
    } catch (error: any) {
      return { success: false, error: error.message, durationMs: 0 };
    }
  };

  return { tools: [recallSkillTool, semanticSearchTool], executors };
}

/**
 * Phase 3 Integration: Artifact tools (artifact_store, artifact_find).
 * Wraps ArtifactManager behind tool interfaces.
 */
export function createArtifactTools(
  artifactManager: ArtifactManager
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  // artifact_store
  const artifactStoreTool: ToolDefinition = {
    name: 'artifact_store',
    description: 'Save generated content as a tagged artifact and index it for future search. Preferred over write_file when you want the artifact discoverable by other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'File content to save' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags (optional)' },
        type: { type: 'string', description: 'Artifact type: typescript | javascript | json | markdown | python | shell | html | css (auto-inferred if omitted)' },
      },
      required: ['filePath', 'content'],
    },
  };

  executors['artifact_store'] = async (args, context) => {
    try {
      const resolvedArtifact = resolveWithinWorkspace(context.workspaceRoot, args.filePath);
      if (!resolvedArtifact.ok) {
        return { success: false, error: `Artifact store blocked: ${resolvedArtifact.error}`, durationMs: 0 };
      }
      if (!isWithinBoundary(context.workspaceRoot, context.boundary, args.filePath)) {
        return {
          success: false,
          error: `Artifact store blocked by boundary: '${args.filePath}' is outside the allowed write paths [${context.boundary?.join(', ') || ''}].`,
          durationMs: 0,
        };
      }
      const meta = artifactManager.storeArtifact(
        { filePath: args.filePath, content: args.content, hash: '' },
        { tags: args.tags ?? [], type: args.type }
      );
      return {
        success: true,
        output: { filePath: meta.filePath, contentHash: meta.contentHash, type: meta.type, tags: meta.tags },
        durationMs: 0,
      };
    } catch (error: any) {
      return { success: false, error: error.message, durationMs: 0 };
    }
  };

  // artifact_find
  const artifactFindTool: ToolDefinition = {
    name: 'artifact_find',
    description: 'Search previously stored artifacts by name, tags, type, or content preview. Returns file paths and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords in file path, tags, or preview)' },
        type: { type: 'string', description: 'Optional filter by artifact type' },
        tag: { type: 'string', description: 'Optional filter by tag' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: [],
    },
  };

  executors['artifact_find'] = async (args) => {
    try {
      const results = artifactManager.searchArtifacts(args.query ?? '', {
        type: args.type,
        tag: args.tag,
        limit: args.limit ?? 5,
      });
      return {
        success: true,
        output: { query: args.query, results, total: results.length },
        durationMs: 0,
      };
    } catch (error: any) {
      return { success: false, error: error.message, durationMs: 0 };
    }
  };

  return { tools: [artifactStoreTool, artifactFindTool], executors };
}

/**
 * Phase 3 / Etap 7: help and get_tool_schema — dynamic tool introspection.
 * Allows LLMs to discover tool signatures on-demand instead of having them
 * embedded in the static system prompt.
 */
export function createHelpTools(
  registry: ToolRegistry
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  const helpTool: ToolDefinition = {
    name: 'help',
    description: 'List all available tools with one-line descriptions, or get full details for a specific tool. Use this when unsure about available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Optional: specific tool name to get full schema for' },
      },
      required: [],
    },
  };

  executors['help'] = async (args) => {
    if (args.toolName) {
      const def = registry.get(args.toolName);
      if (!def) {
        return { success: false, error: `Unknown tool: ${args.toolName}. Use help without toolName to list all.`, durationMs: 0 };
      }
      return {
        success: true,
        output: {
          name: def.name,
          description: def.description,
          schema: def.inputSchema,
          usage: `{"tool": "${def.name}", "arguments": ${JSON.stringify(Object.fromEntries(Object.keys(def.inputSchema.properties).map((k) => [k, '<value>'])))}}`,
        },
        durationMs: 0,
      };
    }
    // Return short list
    const tools = registry.list().map((t) => ({ name: t.name, description: t.description.slice(0, 80) }));
    return { success: true, output: { tools, total: tools.length }, durationMs: 0 };
  };

  const getToolSchemaTool: ToolDefinition = {
    name: 'get_tool_schema',
    description: 'Get the full JSON Schema for a specific tool\'s arguments. Use before complex tool calls to verify argument structure.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Tool name to get schema for' },
      },
      required: ['toolName'],
    },
  };

  executors['get_tool_schema'] = async (args) => {
    const def = registry.get(args.toolName);
    if (!def) {
      return { success: false, error: `Unknown tool: ${args.toolName}`, durationMs: 0 };
    }
    return { success: true, output: { toolName: args.toolName, schema: def.inputSchema }, durationMs: 0 };
  };

  return { tools: [helpTool, getToolSchemaTool], executors };
}

export function createConsultTools(
  consultFn: (agentRole: string, question: string, from?: string) => Promise<string>
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  const askAgentTool: ToolDefinition = {
    name: 'ask_agent',
    description: 'Request a consultation from another agent (researcher/security/planner) while you work.',
    inputSchema: {
      type: 'object',
      properties: {
        agentRole: { type: 'string', description: 'The role of the agent to consult (researcher, security, planner, etc.)' },
        question: { type: 'string', description: 'The question or task to ask the consulted agent' },
      },
      required: ['agentRole', 'question'],
    },
  };

  executors['ask_agent'] = async (args, context) => {
    try {
      const output = await consultFn(args.agentRole, args.question, context.agentId);
      return { success: true, output, durationMs: 0 };
    } catch (error: any) {
      return { success: false, error: error.message || 'ask_agent failed', durationMs: 0 };
    }
  };

  return { tools: [askAgentTool], executors };
}
