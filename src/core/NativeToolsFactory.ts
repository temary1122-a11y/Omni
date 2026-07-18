/**
 * Native tools factory for OmniFlow ToolRegistry.
 *
 * Registers two zero-config tools that work without API keys:
 *   1. `native_web_search` — DDG-based search (no key required)
 *   2. `native_web_fetch`  — Direct URL content extraction (no key required)
 *   3. `run_js`            — In-process JS sandbox (no Docker required)
 *
 * These are the "always available" fallback tier of OmniFlow's tool stack:
 *   Docker Sandbox → NodeSandbox (run_js)
 *   Exa/Tavily → NativeWebSearch
 *
 * INTEGRATION POINT:
 * Register these in OmniOrchestrator alongside existing tools for EVERY agent
 * that needs execution or web access.
 */

import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult } from './ToolRegistry';
import { resolveWithinWorkspace, isWithinBoundary } from './ToolRegistry';
import { NodeSandbox } from '../shell/NodeSandbox';
import { duckDuckGoSearch, fetchWebContent, researchWithNativeWeb } from '../shell/NativeWebSearch';
import type { SelfLearningEngine, ObservedAction } from './SelfLearningEngine';
import * as fs from 'fs';
import * as path from 'path';

// ─── Native Web Search Tool ──────────────────────────────────────────────

export function createNativeSearchTools(
  workspaceRoot: string
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};

  const searchTool: ToolDefinition = {
    name: 'native_web_search',
    description: 'Search the web using DuckDuckGo (zero-config, no API key required). Returns structured results with titles, URLs, and snippets. Use when Exa/Tavily keys are unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        maxResults: { type: 'number', description: 'Maximum results (default: 5, max: 10)' },
        fetchTopResults: { type: 'number', description: 'Also fetch full content from top N result pages (0 = search only)' },
      },
      required: ['query'],
    },
  };

  executors['native_web_search'] = async (args): Promise<ToolResult> => {
    try {
      const query = String(args.query || '').trim();
      if (!query) {
        return { success: false, error: 'Query is required', durationMs: 0 };
      }

      const fetchTop = typeof args.fetchTopResults === 'number'
        ? Math.min(args.fetchTopResults, 3)
        : 0;

      const summary = await researchWithNativeWeb(query, {
        maxResults: Math.min(args.maxResults ?? 5, 10),
        timeoutMs: 15000,
        fetchTopResults: fetchTop,
      });

      return {
        success: true,
        output: { query, summary, source: 'duckduckgo-native' },
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Native search failed: ${error.message || String(error)}`,
        durationMs: 0,
      };
    }
  };

  const fetchTool: ToolDefinition = {
    name: 'native_web_fetch',
    description: 'Fetch and extract text content from a URL. No API key required. Strips HTML, returns clean text with links. Use to read documentation, articles, or any web page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (https://...)' },
        maxContentLength: { type: 'number', description: 'Maximum characters to return (default: 8192)' },
      },
      required: ['url'],
    },
  };

  executors['native_web_fetch'] = async (args): Promise<ToolResult> => {
    try {
      const url = String(args.url || '').trim();
      if (!url || !url.startsWith('http')) {
        return { success: false, error: 'A valid HTTP/HTTPS URL is required', durationMs: 0 };
      }

      const result = await fetchWebContent(url, {
        maxContentLength: args.maxContentLength ?? 8192,
        timeoutMs: 10000,
      });

      if (!result) {
        return {
          success: false,
          error: `Failed to fetch ${url}`,
          durationMs: 0,
        };
      }

      return {
        success: result.statusCode < 400,
        output: {
          url: result.url,
          title: result.title,
          contentType: result.contentType,
          textContent: result.textContent,
          links: result.links,
        },
        durationMs: 0,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Web fetch failed: ${error.message || String(error)}`,
        durationMs: 0,
      };
    }
  };

  return { tools: [searchTool, fetchTool], executors };
}

// ─── Node Sandbox Tool ──────────────────────────────────────────────────

export function createNodeSandboxTools(
  workspaceRoot: string
): { tools: ToolDefinition[]; executors: Record<string, ToolExecutor> } {
  const executors: Record<string, ToolExecutor> = {};
  const sandbox = new NodeSandbox({
    workspaceRoot,
    timeoutMs: 30000,
    maxOutputBytes: 65536,
    allowBuiltins: true,
  });

  const runJsTool: ToolDefinition = {
    name: 'run_js',
    description: 'Execute JavaScript code in a secure in-process sandbox. Works WITHOUT Docker. FS access is workspace-bounded, dangerous patterns are blocked. Use for quick computations, data processing, or when the Docker sandbox is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Use console.log() for output. FS ops (read, write) are available via require("fs") but scoped to workspace.' },
      },
      required: ['code'],
    },
  };

  executors['run_js'] = async (args): Promise<ToolResult> => {
    try {
      const code = String(args.code || '').trim();
      if (!code) {
        return { success: false, error: 'Code is required', durationMs: 0 };
      }

      const result = await sandbox.run(code);

      if (result.refused) {
        return {
          success: false,
          error: `Sandbox refused: ${result.refuseReason}`,
          durationMs: result.executionTimeMs,
        };
      }

      return {
        success: result.exitCode === 0,
        output: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
        error: result.exitCode !== 0 ? result.stderr || `Exit code: ${result.exitCode}` : undefined,
        durationMs: result.executionTimeMs,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `run_js failed: ${error.message || String(error)}`,
        durationMs: 0,
      };
    }
  };

  return { tools: [runJsTool], executors };
}

// ─── Self-Learning Integration ──────────────────────────────────────────

export interface LearningIntegration {
  /** Attach learning hooks to an agent runtime's tool result callback. */
  onToolResult: (agentId: string, toolName: string, result: ToolResult, args: any) => void;
  /** Suggest strategies before a build task. */
  suggestForTask: (goal: string, complexity: 'LOW' | 'MEDIUM' | 'HIGH', agentRole: string) => string;
  /** Check if current tool call matches a known failure pattern. */
  checkRisk: (toolName: string, toolArgs: any, agentId: string) => string | null;
  /** Get engine summary for cockpit/logs. */
  getLearningSummary: () => string;
}

export function createLearningIntegration(
  engine: SelfLearningEngine,
  workspaceRoot: string
): LearningIntegration {
  return {
    onToolResult(agentId, toolName, result, args) {
      engine.observe({
        agentId: agentId as any,
        toolName,
        toolArgs: typeof args === 'object' ? args : { cmd: String(args) },
        success: result.success,
        durationMs: result.durationMs ?? 0,
        timestamp: Date.now(),
      });
    },

    suggestForTask(goal, complexity, agentRole) {
      const strategies = engine.suggestStrategies(
        goal,
        complexity,
        agentRole as any
      );

      if (strategies.length === 0) return '';

      const lines = strategies.map((s, i) => {
        const seq = s.strategy.toolSequence.map(t => t.toolName).join(' → ');
        return `${i + 1}. **${s.name}** (${(s.stats.successRate * 100).toFixed(0)}% success, ${s.stats.usageCount}× used)\n   Sequence: ${seq}\n   Hint: ${s.strategy.promptHints.join('; ') || 'Follow the proven sequence.'}`;
      });

      return `\n\n## Self-Learning Engine suggests proven strategies:\n${lines.join('\n')}\n\nConsider using the highest-success strategy above.`;
    },

    checkRisk(toolName, toolArgs, agentId) {
      return engine.checkFailureRisk(toolName, toolArgs, agentId);
    },

    getLearningSummary() {
      return engine.getSummary();
    },
  };
}
