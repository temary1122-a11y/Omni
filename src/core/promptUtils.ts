import type { ContextPacket, ResearchReport } from '../../shared/types';
import type { ToolDefinition } from './ToolRegistry';
import { CrossPlatformShell } from '../shell/CrossPlatformShell';

/** Format research report into a prompt block shared by planner/coder/researcher. */
export function formatResearchBlock(report?: ResearchReport | null): string {
  if (!report) return '';
  const parts: string[] = [];
  if (report.sources?.length) parts.push('Sources (real web results):\n- ' + report.sources.join('\n- '));
  if (report.bestPractices?.length) parts.push('Best practices:\n- ' + report.bestPractices.join('\n- '));
  if (report.patterns?.length) parts.push('Patterns:\n- ' + report.patterns.join('\n- '));
  if (report.terms?.length) parts.push('Key terms:\n- ' + report.terms.join('\n- '));
  return parts.join('\n');
}

export interface RuntimeUserMessageOptions {
  contextLimit: number;
  registeredTools?: ToolDefinition[];
  relevantTools?: ToolDefinition[];
  showOnlyRelevantTools?: boolean;
  disableToolListing?: boolean;
}

/** Canonical user-turn assembler for AgentRuntime (was duplicated inline). */
export function buildRuntimeUserMessage(
  goal: string,
  context: ContextPacket,
  options: RuntimeUserMessageOptions
): string {
  let message = `Goal: ${goal}\n\n`;

  const estimatedTokens = Math.ceil(message.length / 4);
  message += `[CONTEXT BUDGET: ~${estimatedTokens} / ${options.contextLimit} tokens used — be concise to stay within limit]\n\n`;

  if (context.workspaceSnapshot) {
    message += `Workspace:\n`;
    message += `- Files: ${context.workspaceSnapshot.fileTree.join(', ')}\n`;
    message += `- Has package.json: ${context.workspaceSnapshot.hasPackageJson}\n`;
    if (context.plannedStack && context.plannedStack.length) {
      message += `- PLANNED STACK (authoritative — implement in this): ${context.plannedStack.join(', ')}\n`;
    } else {
      message += `- Detected workspace stack: ${context.workspaceSnapshot.techStack.join(', ')}\n`;
    }
    message += `- Derive the target language/file type from the PLANNED STACK above and the artifact file extension.\n`;
  }

  try {
    message += `\nHost environment: ${CrossPlatformShell.shellInfo()}\n`;
    message += `Use shell commands valid for that environment. Prefer the write_file/read_file tools over shell when possible.\n`;
  } catch { /* ignore */ }

  if (context.researchSummary) {
    message += `Research: ${context.researchSummary}\n\n`;
  }
  if (context.researchReport) {
    const r = context.researchReport;
    if (r.sources?.length) message += `Research sources:\n${r.sources.map((s) => '- ' + s).join('\n')}\n\n`;
    if (r.bestPractices?.length) message += `Research best practices:\n${r.bestPractices.map((s) => '- ' + s).join('\n')}\n\n`;
    if (r.patterns?.length) message += `Research patterns:\n${r.patterns.map((s) => '- ' + s).join('\n')}\n\n`;
  }

  if (context.planSummary) {
    message += `Plan: ${context.planSummary}\n\n`;
  }

  if (!options.disableToolListing && options.relevantTools?.length) {
    message += `Most relevant tools (exact names + required args):\n`;
    for (const t of options.relevantTools) {
      const req = t.inputSchema.required ?? [];
      const argSummary = req.map((r) => `${r}:<value>`).join(', ');
      message += `- ${t.name}(${argSummary}) — ${t.description.slice(0, 90)}\n`;
    }
    message += `If you are unsure about an argument, re-read the tool name and required args listed above, or use the help tool for more.\n`;
  }

  if (!options.disableToolListing && options.registeredTools && !options.showOnlyRelevantTools) {
    message += `Available tools (exact names + required args):\n`;
    for (const t of options.registeredTools) {
      const req = t.inputSchema.required ?? [];
      const argSummary = req.map((r) => `${r}:<value>`).join(', ');
      message += `- ${t.name}(${argSummary}) — ${t.description.slice(0, 90)}\n`;
    }
    message += `If you are unsure about an argument, re-read the tool name and required args listed above, and emit a single tool call as JSON.\n`;
  }

  const cp = context as unknown as Record<string, unknown>;
  if (cp.agentsMd) {
    message += `\n## Project conventions (AGENTS.md)\n${String(cp.agentsMd).slice(0, 2000)}\n`;
  }
  if (cp.omniMd) {
    message += `\n## Project memory (OMNI.md)\n${String(cp.omniMd).slice(0, 2000)}\n`;
  }

  message += `\nTo use a tool, output JSON in this format:\n`;
  message += `{"tool": "tool_name", "arguments": {...}}\n\n`;
  message += `Please complete the goal. Think step by step.`;

  return message;
}
