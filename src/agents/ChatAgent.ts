import { ModelRouter } from '../routing/ModelRouter';
import { AgentRuntime } from '../core/AgentRuntime';
import {
  ToolRegistry,
  createDefaultTools,
  createCodeSearchTools,
  createMemoryTools,
  createHelpTools,
  createConsultTools,
  type ToolDefinition,
} from '../core/ToolRegistry';
import { SandboxTool } from '../shell/SandboxTool';
import { SemanticEditor } from '../shell/SemanticEditor';
import { BuiltInCodeIndex } from '../core/BuiltInCodeIndex';
import { EventBus } from '../core/EventBus';
import type { ConsultFn } from '../core/AgentConsultant';
import type { MemoryFacade } from '../memory/MemoryFacade';
import type { ArtifactManifest } from '../../shared/types';
import * as crypto from 'crypto';

/**
 * Chat agent — the "answer directly" path.
 *
 * It reuses the SAME model-driven ReAct loop as the coder (AgentRuntime), but
 * with a READ-ONLY tool set. The model receives the question and decides for
 * itself whether to call a read tool (e.g. to inspect a file) or answer
 * directly — exactly like Claude Code / Codex, where a quick question may take
 * one tool call and end, while a deeper one chains several. No hardcoded
 * sequence, no coder, no build/verify loop.
 */
export class ChatAgent {
  agentId = 'chat';
  private consultFn?: ConsultFn;
  private memory?: MemoryFacade;

  constructor(
    private router: ModelRouter,
    private apiKeys: Record<string, string>,
    private eventBus: EventBus,
    memory?: MemoryFacade
  ) {
    this.memory = memory;
  }

  setConsultFn(fn: ConsultFn): void {
    this.consultFn = fn;
  }

  async answer(goal: string, workspaceRoot: string): Promise<string> {
    const toolRegistry = new ToolRegistry(this.eventBus);
    const defs: ToolDefinition[] = [];
    const register = (name: string, def: ToolDefinition, exec: any) => {
      toolRegistry.register(name, def, exec);
      defs.push(def);
    };

    // Read-only tools only. We deliberately exclude write_file / bash / replace_symbol.
    if (workspaceRoot) {
      const sandbox = new SandboxTool({ workspaceRoot, eventBus: this.eventBus });
      const semantic = new SemanticEditor(workspaceRoot);
      const { tools, executors } = createDefaultTools(sandbox, semantic, workspaceRoot);
      const readFile = tools.find((t) => t.name === 'read_file');
      if (readFile) register('read_file', readFile, executors['read_file']);

      try {
        const codeIndex = new BuiltInCodeIndex({ workspaceRoot, maxTokens: 12000 });
        const codeTools = createCodeSearchTools(codeIndex as any, workspaceRoot);
        for (const t of codeTools.tools) register(t.name, t, codeTools.executors[t.name]);
      } catch {
        // Code index unavailable — chat can still answer without it.
      }
    }

    if (this.memory) {
      const memTools = createMemoryTools(this.memory);
      for (const t of memTools.tools) register(t.name, t, (memTools.executors as any)[t.name]);
    }

    const helpTools = createHelpTools(toolRegistry);
    for (const t of helpTools.tools) register(t.name, t, (helpTools.executors as any)[t.name]);

    if (this.consultFn) {
      const ct = createConsultTools(this.consultFn);
      for (const t of ct.tools) register(t.name, t, ct.executors[t.name]);
    }

    const systemPrompt = `You are Omni, a helpful AI assistant integrated into the user's editor.
You answer questions, explain concepts, reason about code, and hold a conversation.
You are in CHAT mode: do NOT create or write project files unless the user explicitly asks you to produce a file.
You have read-only tools (read_file, semantic code search, memory) you MAY use to inspect the
workspace when it genuinely helps your answer — but for a general question, just answer.
Be concise, accurate, and friendly. If you used a tool, briefly say what you found.`;

    const runtime = new AgentRuntime(this.eventBus!, this.router, toolRegistry, {
      agentId: 'chat',
      tools: defs,
      maxIterations: 10,
      systemPrompt,
      workspaceRoot,
      // Chat is a free-form conversation: disable TaskCompass drift enforcement so
      // the model isn't forced to "stay on a goal" for a casual question.
      enableTaskCompass: false,
      apiKeys: this.apiKeys,
      memory: this.memory,
    } as any);

    const taskId = `chat_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const manifest: ArtifactManifest = await runtime.run(goal, {
      taskId,
      goal,
      workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
    } as any);

    const answer = (manifest.selfVerification || '').trim();
    if (!answer) {
      return (
        "I'm Omni — your in-editor AI assistant. I can answer questions, explain code, and help you build things. " +
        "(My language model didn't return a response — check your API key / provider status in Omni settings.)"
      );
    }
    return answer;
  }
}
