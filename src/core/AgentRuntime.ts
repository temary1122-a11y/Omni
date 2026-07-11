import { EventBus } from './EventBus';
import { ToolRegistry, ToolDefinition, ToolContext, ToolResult } from './ToolRegistry';
import { ModelRouter } from '../routing/ModelRouter';
import type { LLMResponse } from '../routing/LLMClient';
import { TaskCompass } from './TaskCompass';
import { MemoryFacade } from '../memory/MemoryFacade';
import { ContextGovernor } from './ContextGovernor';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ContextPacket, ArtifactManifest, FileArtifact } from '../../shared/types';
import { buildRuntimeUserMessage } from './promptUtils';
import { parseToolCalls } from './ToolCallParser';

export interface AgentRuntimeOptions {
   agentId: string;
   tools: ToolDefinition[];
   maxIterations: number;
   systemPrompt: string;
   workspaceRoot?: string;
   onReasoning?: (thought: string) => void;
   onToolCall?: (tool: string, args: any) => void;
   onToolResult?: (tool: string, result: ToolResult) => void;
   enableTaskCompass?: boolean;
   taskCompassRefreshInterval?: number;
    apiKeys?: Record<string, string>;
    /** Write-boundary (relative paths/dirs) the agent may write to. Enforced in ToolRegistry. */
    boundary?: string[];
    /** Shared memory facade. If omitted, memory features are disabled. */
    memory?: MemoryFacade;
   /** Importance threshold for episodic recording. Default: 0.5 */
   episodeImportance?: number;
   /** If true, omit even the short tools hint from buildUserMessage. Default: false */
    disableToolListingInSystemPrompt?: boolean;
    /** Called before each ReAct iteration. May inject a system note or force-stop. */
    onIteration?: (iteration: number, ctx: { toolCallCount: number; messages: string }) => { systemNote?: string; shouldStop?: boolean };
    /** Shared TaskCompass instance. If provided, the runtime uses it instead of
     *  creating its own (so the whole task shares ONE compass). */
     taskCompass?: TaskCompass;
     /** Drift threshold passed to a locally-created TaskCompass. Default: 0.6 */
     driftThreshold?: number;
      /** Explicit context-window override in tokens. When omitted, the runtime resolves
       *  the active model's real context window from the ModelRouter registry
       *  (e.g. Step 3.7 Flash = 262144, Nemotron 3 Super = 1048576). */
      contextLimit?: number;
   }

export interface ReActStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'final';
  content: string;
  toolName?: string;
  toolArgs?: any;
  toolResult?: ToolResult;
  timestamp: number;
}

export class AgentRuntime {
  private eventBus: EventBus;
  private modelRouter: ModelRouter;
  private toolRegistry: ToolRegistry;
  private options: AgentRuntimeOptions;
  private taskCompass: TaskCompass | null = null;
  private memory: MemoryFacade | null;
  private contextGovernor: ContextGovernor | null = null;
  /** Cached real context window (tokens) for the active model, resolved lazily. */
  private cachedContextWindow = 0;

  private consecutiveDrift = 0;
  private driftStopRequested = false;
  private consecutiveBashFailures = 0;
  private sandboxNoteEmitted = false;
  /** Redirect captured from the last drifted action, injected into the NEXT LLM turn. */
  private pendingRedirect: string | null = null;
  private recentActions: string[] = [];
  private consecutiveRepeats = 0;

  constructor(
    eventBus: EventBus,
    modelRouter: ModelRouter,
    toolRegistry: ToolRegistry,
    options: AgentRuntimeOptions
  ) {
    this.eventBus = eventBus;
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
    this.options = options;
    this.memory = options.memory ?? null;

    // Initialize ContextGovernor for context compaction
    this.contextGovernor = new ContextGovernor(eventBus, modelRouter);

    // TaskCompass initialized in run() with actual goal
    if (options.enableTaskCompass !== false) {
      // Will be initialized in run()
    }
  }

  async run(goal: string, context: ContextPacket): Promise<ArtifactManifest> {
    const steps: ReActStep[] = [];
    const writtenArtifacts: Array<{filePath: string; content: string}> = [];
    const toolContext: ToolContext = {
      // Use the real workspace root, NOT the first file name (previous bug wrote files
      // relative to a file path instead of the workspace).
      workspaceRoot: this.options.workspaceRoot || '',
      agentId: this.options.agentId,
      taskId: context.taskId,
      boundary: this.options.boundary,
    };

    // Initialize TaskCompass with the goal. Prefer an explicitly shared instance
    // (passed by the orchestrator so the WHOLE task uses ONE compass), then fall
    // back to the process-wide shared instance, and only create a local one if
    // neither is available (keeps existing tests/callers working).
    if (this.options.enableTaskCompass !== false) {
      let createdLocal = false;

      if (this.options.taskCompass) {
        this.taskCompass = this.options.taskCompass;
      } else if (TaskCompass.getSharedInstance()) {
        this.taskCompass = TaskCompass.getSharedInstance()!;
      } else {
        this.taskCompass = new TaskCompass(goal, {
          type: 'adaptive',
          interval: this.options.taskCompassRefreshInterval || 5,
          driftThreshold: this.options.driftThreshold ?? 0.6,
        });
        createdLocal = true;
      }

      // Only a locally-owned compass should be re-refined with this runtime's plan;
      // a shared compass is managed by the orchestrator.
      if (createdLocal && context.planSummary) {
        this.taskCompass.setRefinedGoal(goal + '\n' + context.planSummary);
      }

      this.eventBus.emit({
        type: 'REASONING_TRACE',
        payload: {
          agentId: this.options.agentId as any,
          phase: 'build',
          thought: `TaskCompass ${createdLocal ? 'initialized locally' : 'shared'} with goal: ${goal.substring(0, 100)}...`,
          timestamp: Date.now(),
        },
      });
    }

    // Build initial messages
    const messages: string[] = [];
    messages.push(`System: ${this.options.systemPrompt}\n`);

    // Inject the shared goal / compass context so the agent can check every action
    // against the TRUE GOAL. Present for researcher, planner, coder (and any runtime
    // that has a compass).
    if (this.taskCompass) {
      messages.push(`System: ${this.taskCompass.getContextBlock()}\n`);
    }

    // ── Memory: inject relevant past episodes into context ────────────────
    if (this.memory) {
      const memBlock = this.memory.buildMemoryContextBlock(
        `${goal} ${context.planSummary ?? ''} ${context.researchSummary ?? ''}`.trim(),
        3
      );
      if (memBlock) {
        messages.push(memBlock);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    messages.push(`User: ${this.buildUserMessage(goal, context)}\n`);

    let iteration = 0;
    let finalResponse = '';
    let toolCallCount = 0;
    let lastAssistantContent = '';
    let lastToolName: string | null = null;
    let consecutiveSameTool = 0;

    while (iteration < this.options.maxIterations) {
      iteration++;

      // External iteration guidance (e.g. research saturation nudge from ResearchAgent)
      if (this.options.onIteration) {
        const hint = this.options.onIteration(iteration, {
          toolCallCount,
          messages: messages.join('\n'),
        });
        if (hint.systemNote) {
          messages.push(`System: ${hint.systemNote}\n`);
        }
        if (hint.shouldStop) {
          finalResponse = lastAssistantContent || finalResponse;
          steps.push({ type: 'final', content: finalResponse, timestamp: Date.now() });
          break;
        }
      }

      // Enforced drift: if TaskCompass flagged unaligned actions 3+ times in a row,
      // terminate the ReAct loop instead of looping forever on bad actions.
      if (this.driftStopRequested) {
        finalResponse = lastAssistantContent || 'Stopped: prolonged goal drift detected.';
        steps.push({ type: 'final', content: finalResponse, timestamp: Date.now() });
        break;
      }

      // Inject any pending TaskCompass redirect into this turn so the model actively
      // re-focuses on the true goal before it acts again.
      if (this.pendingRedirect) {
        messages.push(`System: TaskCompass redirect — ${this.pendingRedirect}\n`);
        this.pendingRedirect = null;
      }

      // ── Context compaction to prevent overflow ─────────────────────────────
      // Apply ContextGovernor to compact messages before LLM call, preventing
      // finish_reason: "length" and empty responses from free models with small windows.
      if (this.contextGovernor && messages.length > 5) {
        try {
          // Convert string messages to {role, content} format for ContextGovernor
          const messageObjects = messages.map(m => {
            const parts = m.split(':');
            const role = parts[0].toLowerCase().trim();
            const content = parts.slice(1).join(':').trim();
            return { role, content };
          });

          // Adaptive per-model context budget. Instead of a single conservative constant,
          // resolve the ACTIVE model's real context window (e.g. Step 3.7 Flash 262K,
          // Nemotron 3 Super 1M) from the router registry and compact against that.
          const contextWindow = this.resolveContextWindow();
          // Reserve room for the model's own output plus a safety margin so we never
          // ship a prompt that overflows the window.
          const outputReserve = 8000;
          const maxTokens = Math.max(12000, contextWindow - outputReserve); // hard trigger
          const targetTokens = Math.max(8000, Math.floor(maxTokens * 0.8)); // compact-down goal
          const govResult = await this.contextGovernor.govern(
            messageObjects,
            {
              maxTokens,
              targetTokens,
              preserveRecentTurns: 5,  // Preserve more recent turns for better context
              enableSelectiveRetrieval: true,
              enableHierarchicalSummarization: true,
              enableTokenBudgeting: true,
            }
          );

          // Replace messages with compacted version
          messages.length = 0;
          for (const m of govResult.preservedMessages) {
            messages.push(`${m.role.toUpperCase()}: ${m.content}\n`);
          }
        } catch (error) {
          // If compaction fails, continue with original messages
          console.warn('[AgentRuntime] Context compaction failed, using original messages:', error);
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Call LLM with current context; expose tool schemas for native function calling.
      const toolsSchema = this.toolRegistry.toOpenAITools();
      const response = await this.callLLM(messages.join('\n'), toolsSchema);

      // Emit reasoning if present
      if (response.reasoning) {
        this.options.onReasoning?.(response.reasoning);
        steps.push({
          type: 'thought',
          content: response.reasoning,
          timestamp: Date.now(),
        });
      }

      // Prefer native function-calling tool calls; fall back to text/regex parsing.
      const nativeCalls = (response.toolCalls ?? []).map((tc: any) => ({
        name: tc.name,
        arguments: tc.arguments ?? {},
      }));
      const textCalls = nativeCalls.length > 0 ? [] : parseToolCalls(response.content, (n) => !!this.toolRegistry.get(n));
      const toolCalls = [...nativeCalls, ...textCalls];

      if (toolCalls.length > 0) {
        // Add assistant response to history
        messages.push(`Assistant: ${response.content}\n`);
        lastAssistantContent = response.content;

        for (const toolCall of toolCalls) {
           const toolName = toolCall.name;
           const toolArgs = toolCall.arguments;

           // Check alignment with TaskCompass if enabled
           if (this.taskCompass) {
             const actionDescription = `Call tool ${toolName} with args: ${JSON.stringify(toolArgs)}`;
             const currentContext = messages.slice(-3).join('\n');
             const alignment = this.taskCompass.checkAlignment(actionDescription, currentContext);

             this.eventBus.emit({
               type: 'REASONING_TRACE',
               payload: {
                 agentId: this.options.agentId as any,
                 phase: 'build',
                 thought: `TaskCompass alignment: ${alignment.aligned ? 'ALIGNED' : 'DRIFTING'} (${alignment.confidence.toFixed(2)} confidence, ${alignment.driftScore.toFixed(2)} drift) - ${alignment.reasoning}`,
                 timestamp: Date.now(),
               },
             });

               if (!alignment.aligned) {
                 this.consecutiveDrift++;
                 if (alignment.suggestedRedirect) {
                   // Capture the redirect so it is injected into the model's NEXT
                   // input turn (not just logged), forcing an active re-focus.
                   this.pendingRedirect = alignment.suggestedRedirect;
                 }
                if (this.consecutiveDrift >= 3 && !this.driftStopRequested) {
                  this.driftStopRequested = true;
                  messages.push(
                    `System: TaskCompass detected prolonged drift (3+ consecutive unaligned actions) — STOP and re-focus on the primary goal, or revise the goal.\n`
                  );
                }
              } else {
                this.consecutiveDrift = 0;
              }
           }

            this.options.onToolCall?.(toolName, toolArgs);
            steps.push({
             type: 'tool_call',
             content: `Calling ${toolName}`,
             toolName,
             toolArgs,
             timestamp: Date.now(),
           });

            // ── Repetition / stall breaker ────────────────────────────────
            // Hash the (tool + args). If the SAME action repeats 3 times in a
            // row with no progress, force-stop the ReAct loop (catches waffling
            // like "Python vs Node.js", endless re-exploration, or a tool that
            // keeps failing identically) regardless of TaskCompass semantic score.
            //
            // For file-writing tools we drop the blob `content` from the key so
            // repeated writes to the SAME path are detected even when the model
            // reformulates the body each retry. Observed failure: free models retry
            // write_file with slightly different JSON content, which escaped the old
            // exact-match key and looped for minutes ("the process stalls").
            let keyArgs: any = toolArgs;
            if (toolName === 'write_file' || toolName === 'writeFile' || toolName === 'create_file') {
              const rest = { ...(toolArgs || {}) } as Record<string, any>;
              const content = String(rest.content || '');
              rest._contentFp = content.slice(0, 200) + '|' + content.length;
              delete rest.content;
              keyArgs = rest;
            }
            const actionKey = toolName + '|' + JSON.stringify(keyArgs);
            if (this.recentActions.length > 0 && this.recentActions[this.recentActions.length - 1] === actionKey) {
              this.consecutiveRepeats++;
            } else {
              this.consecutiveRepeats = 0;
            }
            this.recentActions.push(actionKey);
             if (this.consecutiveRepeats >= 3) {
               finalResponse = lastAssistantContent || 'Stopped: repeated identical action detected (possible loop).';
               steps.push({ type: 'final', content: finalResponse, timestamp: Date.now() });
               break;
             }

             if (lastToolName === toolName) {
               consecutiveSameTool++;
             } else {
               consecutiveSameTool = 0;
             }
             lastToolName = toolName;
             if (consecutiveSameTool >= 3) {
               finalResponse = lastAssistantContent || `Stopped: repeated ${toolName} calls detected — stopping to avoid a loop.`;
               steps.push({ type: 'final', content: finalResponse, timestamp: Date.now() });
               messages.push(`Tool (${toolName}): ⚠ Repeated ${toolName} calls detected — stopping to avoid a loop.\n`);
               break;
             }

            let result: ToolResult;
            if (toolName === 'write_file' && (!toolArgs || typeof toolArgs.path !== 'string' || toolArgs.path.trim() === '')) {
              result = {
                success: false,
                error: "write_file requires a non-empty 'path' argument (e.g. path: 'generated/plan.json') together with 'content'. Provide both.",
                output: '',
              } as ToolResult;
            } else {
              result = await this.toolRegistry.execute(toolName, toolArgs, toolContext);
            }
            if (toolName === 'write_file' && result.success) {
             writtenArtifacts.push({ filePath: toolArgs.path, content: toolArgs.content || '' });
           }

           // ── Memory: record tool step episode ─────────────────────────────
           if (this.memory) {
             const importance = result.success
               ? (this.options.episodeImportance ?? 0.5)
               : 0.7; // failures are more important to remember
             const excerpt = (
               typeof result.output === 'string'
                 ? result.output
                 : JSON.stringify(result.output ?? {})
             ).slice(0, 200) ||
               (result.error ?? '').slice(0, 200);
             this.memory.recordEpisode(
               'tool_result',
               {
                 agentId: this.options.agentId,
                 toolName,
                 success: result.success,
                 argsHash: crypto.createHash('md5').update(JSON.stringify(toolArgs)).digest('hex').slice(0, 8),
                 excerpt,
                 timestamp: Date.now(),
               },
               importance
             );
           }
           // ─────────────────────────────────────────────────────────────────

           this.options.onToolResult?.(toolName, result);
          steps.push({
            type: 'tool_result',
            content: result.success ? 'Success' : `Error: ${result.error}`,
            toolName,
            toolResult: result,
            timestamp: Date.now(),
          });

          // Add tool result to history
           messages.push(`Tool (${toolName}): ${result.success ? (result.output !== undefined && result.output !== null ? JSON.stringify(result.output) : '(no output)') : `Error: ${result.error}`}\n`);

          // Bash/sandbox failure resilience: when the terminal/sandbox is unavailable
          // (container down, Windows encoding), stop the model from looping on bash.
          if (toolName === 'bash' || toolName === 'run_command' || toolName === 'exec') {
            if (!result.success) {
              const errText = (result.error || '').toLowerCase();
               const sandboxDown = /enoent|not recognized|command not found|commande introuvable|не является|не найдена|nicht gefunden|no such file|docker_engine|is not a cmdlet|cannot be loaded|denied|syntax error|codepage|chcp|exit code: [1-9]/i.test(errText);
              if (sandboxDown) {
                this.consecutiveBashFailures++;
                 if (this.consecutiveBashFailures >= 2 && !this.sandboxNoteEmitted) {
                  messages.push(
                    `System: Sandbox/terminal is unavailable in this environment — STOP calling bash; ` +
                    `create and modify files using the write_file / read_file tools directly.\n`
                  );
                  this.sandboxNoteEmitted = true;
                  this.consecutiveBashFailures = 0;
                }
              } else {
                this.consecutiveBashFailures = 0;
              }
            }
          }
        }
        toolCallCount += toolCalls.length;
      } else {
        // No tool calls - this is the final response
        finalResponse = response.content;
        steps.push({
          type: 'final',
          content: response.content,
          timestamp: Date.now(),
        });
        break;
      }
    }

    // Emit reasoning trace
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: this.options.agentId as any,
        phase: 'build',
        thought: `ReAct loop completed in ${iteration} iterations`,
        timestamp: Date.now(),
      },
    });

    // Emit TaskCompass summary if enabled
    if (this.taskCompass) {
      const summary = this.taskCompass.getAlignmentSummary();
      this.eventBus.emit({
        type: 'REASONING_TRACE',
        payload: {
          agentId: this.options.agentId as any,
          phase: 'build',
          thought: `TaskCompass summary: ${summary.totalChecks} alignment checks, ${summary.alignmentRate.toFixed(2)} alignment rate, avg drift ${summary.avgDriftScore.toFixed(2)}`,
          timestamp: Date.now(),
        },
      });
    }

    return this.buildArtifactManifest(finalResponse, context, writtenArtifacts, this.options.workspaceRoot);
  }

  /**
   * Resolve the real context window (in tokens) for the model currently backing this
   * agent. Priority:
   *   1. explicit override via options.contextLimit,
   *   2. the active model's real context window from the ModelRouter registry
   *      (e.g. Step 3.7 Flash 262144, Nemotron 3 Super 1048576),
   *   3. a conservative 32000 fallback only when the model is unknown.
   * Cached after first resolution since the backing model is stable per run.
   */
  private resolveContextWindow(): number {
    if (this.options.contextLimit && this.options.contextLimit > 0) {
      return this.options.contextLimit;
    }
    if (this.cachedContextWindow && this.cachedContextWindow > 0) {
      return this.cachedContextWindow;
    }
    let resolved = 0;
    try {
      resolved = this.modelRouter.getContextWindowForRole?.(this.options.agentId as any) ?? 0;
    } catch {
      resolved = 0;
    }
    // Conservative fallback for modern models only when the registry has no entry.
    this.cachedContextWindow = resolved > 0 ? resolved : 32000;
    return this.cachedContextWindow;
  }

  private async callLLM(prompt: string, tools?: any[]): Promise<any> {
    let response: LLMResponse;
    try {
      response = await this.modelRouter.call(
        { phase: 'build', agentRole: this.options.agentId as any, complexity: 'medium' },
        prompt,
        this.options.systemPrompt,
        this.options.apiKeys || {},
        undefined,
        tools
      );
    } catch (error: any) {
      console.error(`AgentRuntime [${this.options.agentId}] LLM call failed:`, error.message);
      return {
        content: `Error: ${error.message}`,
        reasoning: undefined,
        toolCalls: [],
      };
    }

    if (response.usedFallback && this.options.agentId === 'coder') {
      throw new Error(
        'CoderAgent: LLM providers unavailable — cannot generate code offline. ' +
        'Fix: set a working API key / provider in Omni settings and retry.'
      );
    }

    if (!response.content && response.reasoning) {
      response.content = response.reasoning;
    }

    return {
      content: response.content,
      reasoning: response.reasoning,
      toolCalls: response.toolCalls ?? [],
    };
  }

  private buildUserMessage(goal: string, context: ContextPacket): string {
    return buildRuntimeUserMessage(goal, context, {
      contextLimit: this.resolveContextWindow(),
      registeredTools: this.toolRegistry.list(),
      disableToolListing: this.options.disableToolListingInSystemPrompt,
    });
  }

  private buildArtifactManifest(
     response: string,
     context: ContextPacket,
     writtenArtifacts: Array<{filePath: string; content: string}>,
     workspaceRoot?: string
   ): ArtifactManifest {
     const artifacts: FileArtifact[] = [];
     const seen = new Set<string>();

     const addArtifact = (fp: string, content: string) => {
       if (seen.has(fp)) return;
       seen.add(fp);
       artifacts.push({
         filePath: fp,
         content: content || '',
         hash: this.hashContent(content),
       });
     };

     for (const art of writtenArtifacts) {
       addArtifact(art.filePath, art.content);
     }

     const filePattern = /(?:create|write|save|generate|built|wrote|saved)\s+(?:file\s+)?['"]?([^'"`\s]+\.(ts|js|json|md|txt|py|yaml|yml|sh))['"]?/gi;
     let match;
     while ((match = filePattern.exec(response)) !== null) {
       const fp = match[1];
       if (seen.has(fp)) continue;
       if (workspaceRoot) {
         try {
           const full = path.join(workspaceRoot, fp);
           if (fs.existsSync(full)) {
             const content = fs.readFileSync(full, 'utf-8');
             addArtifact(fp, content);
             continue;
           }
         } catch { /* ignore */ }
       }
       addArtifact(fp, '');
     }

     return {
       artifacts,
       subtaskId: context.taskId,
       completedAt: Date.now(),
       selfVerification: response,
     };
   }

   private hashContent(content: string): string {
     return crypto.createHash('sha256').update(content).digest('hex');
   }

   // TaskCompass management methods
   getTaskCompassState() {
     return this.taskCompass ? this.taskCompass.getState() : null;
   }

   getTaskCompassSummary() {
     return this.taskCompass ? this.taskCompass.getAlignmentSummary() : null;
   }

   addSubGoal(description: string): string | null {
     return this.taskCompass ? this.taskCompass.addSubGoal(description) : null;
   }

   setCurrentSubGoal(subGoalId: string): void {
     if (this.taskCompass) {
       this.taskCompass.setCurrentSubGoal(subGoalId);
     }
   }

   completeSubGoal(subGoalId: string): void {
     if (this.taskCompass) {
       this.taskCompass.completeSubGoal(subGoalId);
     }
   }

   setRefinedGoal(goal: string): void {
     if (this.taskCompass) {
       this.taskCompass.setRefinedGoal(goal);
     }
   }

   resetTaskCompass(): void {
     if (this.taskCompass) {
       this.taskCompass.reset();
     }
   }
 }
