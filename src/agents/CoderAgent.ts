import { LlmAgent } from './LlmAgent';
import type { HandoffContract, ArtifactManifest } from '../../shared/types';
import { ModelRouter } from '../routing/ModelRouter';
import type { EventBus } from '../core/EventBus';
import { AgentRuntime } from '../core/AgentRuntime';
import { ToolRegistry, createDefaultTools, createConsultTools, createCodeSearchTools, createMemoryTools } from '../core/ToolRegistry';
import { BuiltInCodeIndex } from '../core/BuiltInCodeIndex';
import type { ConsultFn } from '../core/AgentConsultant';
import { formatResearchBlock } from '../core/promptUtils';
import type { MemoryFacade } from '../memory/MemoryFacade';

export class CoderAgent extends LlmAgent {
  agentId = 'coder';
  private consultFn?: ConsultFn;
  private memory?: MemoryFacade;

  constructor(router: ModelRouter, apiKeys: Record<string, string>, eventBus?: EventBus, memory?: MemoryFacade) {
    super('coder', router, apiKeys, eventBus);
    this.memory = memory;
  }

  setConsultFn(fn: ConsultFn): void {
    this.consultFn = fn;
  }

  setMemory(facade: MemoryFacade): void {
    this.memory = facade;
  }

  async execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest> {
    if (!this.validateContract(contract)) throw new Error('Invalid handoff contract');

    const target = contract.artifactTargets[0];
    if (!target) throw new Error('No artifact target');

    const { goal, researchReport, planSummary } = contract.contextPacket;
    const researchBlock = formatResearchBlock(researchReport);
    const ext = target.filePath.split('.').pop() || '';
    const plannedStack = (contract.contextPacket as { plannedStack?: string[] }).plannedStack;
    const stackHint = plannedStack && plannedStack.length
      ? `\nThe PLANNED STACK for this task is: ${plannedStack.join(', ')}. Implement strictly in that stack/language (the artifact file extension indicates the language). Do NOT re-debate or switch stacks (e.g. do not argue Node.js vs Python) — the stack is already decided by the planner.`
      : '';

    this.currentPhase = 'build';
    this.emitCommentary('build', 'Building artifact: ' + target.filePath);
    this.emitReasoning('build', 'Building artifact: ' + target.filePath);

    const sandboxTool = this.getSandboxTool(workspaceRoot);
    const semanticEditor = this.getSemanticEditor(workspaceRoot);
    const { tools, executors } = createDefaultTools(sandboxTool, semanticEditor, workspaceRoot);

    const toolRegistry = new ToolRegistry(this.eventBus!);
    for (const tool of tools) {
      toolRegistry.register(tool.name, tool, executors[tool.name]);
    }

    try {
      const codeIndex = new BuiltInCodeIndex({ workspaceRoot, maxTokens: 12000 });
      const codeTools = createCodeSearchTools(codeIndex as any, workspaceRoot);
      for (const t of codeTools.tools) {
        toolRegistry.register(t.name, t, codeTools.executors[t.name]);
      }
    } catch (e) {
      this.emitCommentary('build', 'Code index unavailable: ' + (e instanceof Error ? e.message : String(e)));
    }

    toolRegistry.register('run_tests', {
      name: 'run_tests',
      description: 'Run the project test/build suite (e.g. npm test, npm run build, npx tsc --noEmit). Returns stdout/stderr and exit status. Use after writing code to verify it works.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: "Optional override command. Defaults to 'npm test' (falls back to build/tsc)." },
        },
        required: [],
      },
    }, async (args: { command?: string }, context: { workspaceRoot: string }) => {
      const { execSync } = require('child_process');
      const cmd = args.command || 'npm test';
      try {
        const out = execSync(cmd, { cwd: context.workspaceRoot, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { success: true, output: { command: cmd, stdout: out.slice(0, 4000) }, durationMs: 0 };
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string };
        const stderr = (err.stderr || err.stdout) ? String(err.stderr || err.stdout) : String(e);
        return { success: false, error: stderr.slice(0, 4000), durationMs: 0 };
      }
    });

    if (this.consultFn) {
      const ct = createConsultTools(this.consultFn);
      for (const t of ct.tools) {
        toolRegistry.register(t.name, t, ct.executors[t.name]);
      }
    }

    if (this.memory) {
      const memTools = createMemoryTools(this.memory);
      for (const t of memTools.tools) {
        const executor = (memTools.executors as any)[t.name];
        toolRegistry.register(t.name, t, executor);
      }
    }

    const bounceContext = (contract.contextPacket as { bounceContext?: { feedback?: string; failedCriteria?: string[]; previousArtifactPaths?: string[] } }).bounceContext;
    const bounceBlock = bounceContext
      ? `\n\n## Previous attempt FAILED — fix it\nFeedback: ${bounceContext.feedback || '(none)'}\nFailed criteria: ${(bounceContext.failedCriteria || []).join('; ') || '(none)'}\nPreviously written: ${(bounceContext.previousArtifactPaths || []).join(', ') || '(none)'}\nAddress the feedback above. Do not repeat the same mistake.`
      : '';

    const rolePrompt = `You are an expert coder. Output production-ready ${ext || 'code'}.
Use tools to read files, write files, and execute commands.${stackHint}
When replacing existing code, use replace_symbol for precise edits.
Always verify your changes by reading the file back.
You may call the ask_agent tool to consult the security, researcher, or planner agent when you need expert input (e.g. security review of a snippet, research on a library, or clarification of the plan).
If the task involves API keys or secrets (like a Groq key), consult the security agent via ask_agent on safe handling/storage.
You operate with disciplined engineering practice:
- Inspect existing files BEFORE editing them; read the relevant code first.
- Prefer minimal, focused changes (small, targeted diffs) over rewriting whole files.
- After running a command that fails, READ the error, analyze it, and retry with a corrected command — do not repeat the same failing command.
- Avoid destructive commands (rm -rf, force-push, drop tables) unless explicitly required.
- Always verify your final change by reading the file back.

## Research context (live web results — ground your implementation in these real sources/practices):
${researchBlock}
You MUST write the implementation to disk using the write_file tool. Never return only a description or a TODO scaffold. Produce complete, working code that fulfills the goal and the compass acceptance criteria.${bounceBlock}`;

    const runtime = new AgentRuntime(
      this.eventBus!,
      this.router,
      toolRegistry,
      {
        agentId: 'coder',
        tools,
        maxIterations: 15,
        driftThreshold: 0.5,
        systemPrompt: this.composeSystemPrompt('build', goal, rolePrompt, { planSummary }),
        workspaceRoot,
        boundary: contract.boundary,
        onReasoning: (thought) => this.emitReasoning('build', thought),
        onToolCall: (tool, args) => this.emitToolCall('build', tool, args),
        onToolResult: (tool, result) => {
          this.emitToolResult('build', tool, result.success, result.output, result.error);
        },
        apiKeys: this.apiKeys,
        memory: this.memory,
      }
    );

    const insistInstruction =
      `You MUST use the write_file tool to actually create the file "${target.filePath}". ` +
      `Do NOT return only text or a TODO placeholder. Write complete, working code.`;

    let manifest = await runtime.run(goal, {
      ...contract.contextPacket,
      taskId: contract.subtaskId,
    });

    const providerDown = /All LLM providers failed|No LLM provider is currently healthy|provider unavailable/i.test(manifest.selfVerification || '');
    if (manifest.artifacts.length === 0 && providerDown) {
      throw new Error(
        'CoderAgent: LLM providers unavailable — cannot generate code. Root cause: ' +
        (manifest.selfVerification || 'no response').slice(0, 400) +
        ' Fix: set a working API key / provider in Omni settings and retry.'
      );
    }

    // If the first run already produced an artifact, do NOT re-run the whole goal
    // from scratch. Re-running re-seeds identical reasoning ("The user wants me to
    // create...") and can clobber the file with a duplicate write. Overwriting the
    // same path once is expected; re-running the entire goal is not.
    if (manifest.artifacts.length === 0) {
      const nudge =
        `Your previous attempt returned only reasoning text and did NOT call the write_file tool. ` +
        `You MUST now call the write_file tool with the COMPLETE file content for "${target.filePath}". ` +
        `Do not return only reasoning.`;

      for (let attempt = 1; attempt < 3 && manifest.artifacts.length === 0; attempt++) {
        this.emitCommentary('build', `No artifacts produced on attempt ${attempt}, retrying (${attempt + 1}/3)`);
        this.emitReasoning('build', `No artifacts produced on attempt ${attempt}, retrying (${attempt + 1}/3)`);
        manifest = await runtime.run(goal + '\n\n' + insistInstruction + '\n\n' + nudge, {
          ...contract.contextPacket,
          taskId: contract.subtaskId,
        });
      }
    }

    const hasRealContent =
      manifest.artifacts.length > 0 &&
      manifest.artifacts.some(a => a.content && a.content.trim().length > 0);

    if (!hasRealContent) {
      throw new Error(
        'CoderAgent: LLM produced no real content for ' + target.filePath +
        ' — build cannot continue. Last model message: ' + (manifest.selfVerification || '(none)').slice(0, 300)
      );
    }

    manifest.artifacts = manifest.artifacts.map(a => ({
      ...a,
      filePath: target.filePath,
    }));

    return manifest;
  }
}
