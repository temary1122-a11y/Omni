import { LlmAgent } from './LlmAgent';
import type { HandoffContract, ArtifactManifest, ExecutionPlan } from '../../shared/types';
import { ModelRouter } from '../routing/ModelRouter';
import type { EventBus } from '../core/EventBus';
import { AgentRuntime } from '../core/AgentRuntime';
import { createConsultTools } from '../core/ToolRegistry';
import type { ConsultFn } from '../core/AgentConsultant';
import { formatResearchBlock } from '../core/promptUtils';
import { sleep, backoffDelayMs } from '../util/async';

export class PlannerAgent extends LlmAgent {
  agentId = 'planner';
  private consultFn?: ConsultFn;

  constructor(router: ModelRouter, apiKeys: Record<string, string>, eventBus?: EventBus) {
    super('planner', router, apiKeys, eventBus);
  }

  setConsultFn(fn: ConsultFn): void {
    this.consultFn = fn;
  }

  async execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest> {
    if (!this.validateContract(contract)) throw new Error('Invalid handoff contract');

    const { goal, taskId, researchSummary, researchReport } = contract.contextPacket;
    const researchBlock = formatResearchBlock(researchReport);

    this.currentPhase = 'planning';
    this.emitCommentary('planning', 'Creating execution plan based on research and user decisions...');
    this.emitReasoning('planning', 'Creating execution plan...');

    const { registry: toolRegistry, tools: plannerTools } = this.createToolRegistry(workspaceRoot, ['read_file']);

    if (this.consultFn) {
      const ct = createConsultTools(this.consultFn);
      for (const t of ct.tools) {
        toolRegistry.register(t.name, t, ct.executors[t.name]);
      }
      plannerTools.push(...ct.tools);
    }

// Create agent runtime
     const rolePrompt = `You are a software architect. Create an MVP execution plan as JSON.
The plan must include: stack (string[]), architecture (string), subtasks (array with description, filePath, contentType).
Return the plan as your final assistant message; it will be written to .omniflow/tasks/${taskId}/execution-plan.json by the system.

CRITICAL OUTPUT REQUIREMENTS:
- Return ONLY valid JSON object (no markdown code blocks, no text before/after)
- Start your response directly with { and end with }
- All keys must be present: stack (array of strings), architecture (string), subtasks (array of objects)
- Each subtask must have: description (string), filePath (string), contentType (string)
- subtasks should be 3-8 specific implementation steps
- filePath should be relative to 'generated/' directory
- contentType should be 'code' or 'doc'

STACK SELECTION RULE:
Choose the stack that BEST FITS the user's GOAL. Do NOT default to Express unless the goal is explicitly an HTTP API.
Examples:
- A Telegram bot with an AI provider → use a Telegram framework (e.g. grammY or Telegraf) + the AI SDK for the chosen provider (e.g. groq-sdk).
- A web app → use a frontend framework (e.g. React via Vite).
- An HTTP API → use Express or a similar framework.
- A library/SDK → use plain TypeScript/JavaScript with a modular structure.

You MAY call the ask_agent tool to consult the researcher agent for library/stack recommendations (e.g. "what is the best Telegram bot framework for Node.js and how to integrate groq-sdk?"). Incorporate the researcher's answer into the plan.

Example output format:
{
  "stack": ["Node.js", "TypeScript", "grammY", "groq-sdk"],
  "architecture": "Telegram bot with AI-powered responses using grammY and Groq",
  "subtasks": [
    {
      "description": "Create package.json with grammY and groq-sdk dependencies",
      "filePath": "generated/package.json",
      "contentType": "code"
    },
    {
      "description": "Create bot entry point with Groq integration",
      "filePath": "generated/src/bot.ts",
      "contentType": "code"
    }
  ]
}

\n## Research context (live web results — ground your plan in these real sources/practices):
${researchBlock}

 Return valid JSON only.`;

     const runtime = new AgentRuntime(
       this.eventBus!,
       this.router,
       toolRegistry,
       {
         agentId: 'planner',
         tools: plannerTools,
         maxIterations: 8,
          systemPrompt: this.composeSystemPrompt('planning', goal, rolePrompt, { researchSummary }),
          workspaceRoot,
          onReasoning: (thought) => this.emitReasoning('planning', thought),
          apiKeys: this.apiKeys,
        }
      );

    // Retry logic for LLM calls with exponential backoff
    const maxRetries = 3;
    let lastError: Error | null = null;
    let manifest: ArtifactManifest | null = null;
    
    // Retained across attempts: the best parsed plan we managed to extract.
    let bestPlan: any | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add delay before retry (exponential backoff)
        if (attempt > 1) {
          const delayMs = backoffDelayMs(attempt - 1, { baseMs: 1000, maxMs: 5000 }); // 1s, 2s, 4s max
          console.log(`[PlannerAgent] Waiting ${delayMs}ms before attempt ${attempt}`);
          await sleep(delayMs);
        }

        manifest = await runtime.run(goal, {
          ...contract.contextPacket,
          taskId: contract.subtaskId,
        });

        // Capture the plan from BOTH possible sources:
        //  (a) the execution-plan.json artifact the model may have written...
        const fromArtifact = manifest.artifacts.find(a => a.filePath.includes('execution-plan.json'))?.content;
        //  (b) ...otherwise the model's final assistant message (selfVerification).
        const fromMessage = manifest.selfVerification;
        const planCandidate = this.extractPlanJson(fromArtifact) ?? this.extractPlanJson(fromMessage);

        // Accept only if it has a subtasks array with >= 1 item, each with a description string.
        if (
          planCandidate &&
          Array.isArray(planCandidate.subtasks) &&
          planCandidate.subtasks.length > 0 &&
          planCandidate.subtasks.every((s: any) => typeof s?.description === 'string' && s.description.length > 0)
        ) {
          console.log(`[PlannerAgent] Got valid plan on attempt ${attempt}`);
          bestPlan = planCandidate;
          break;
        } else {
          console.log(`[PlannerAgent] No valid plan extracted on attempt ${attempt}`);
          if (attempt < maxRetries) continue;
        }
      } catch (runtimeError) {
        console.log(`[PlannerAgent] Runtime failed on attempt ${attempt}:`, runtimeError);
        lastError = runtimeError instanceof Error ? runtimeError : new Error(String(runtimeError));
        if (attempt < maxRetries) continue;
      }
    }

    // Parse the plan from the manifest (preferring a successfully extracted plan)
    let plan: ExecutionPlan;
    if (bestPlan && Array.isArray(bestPlan.subtasks)) {
      const rawSubtasks = bestPlan.subtasks as any[];
      const subtasks = rawSubtasks
        .map((s: any, i: number) => {
          const description = typeof s?.description === 'string' ? s.description : '';
          if (!description) return null;
          return {
            subtaskId: `build_${taskId}_${i}`,
            agentRole: 'coder' as const,
            description,
            successCriteria: [description || 'Implements ' + (s.filePath ?? 'artifact')],
            artifactTargets: [
              { filePath: s.filePath ?? `generated/file${i}.ts`, contentType: (s.contentType ?? 'code') as 'code' },
            ],
            contextPacket: contract.contextPacket,
          };
        })
        .filter((st: any): st is NonNullable<typeof st> => st !== null);

      if (subtasks.length > 0) {
        console.log('[PlannerAgent] Manifest artifacts:', manifest?.artifacts.map(a => ({ filePath: a.filePath, hasContent: Boolean(a.content) })));
        console.log('[PlannerAgent] Subtasks count:', subtasks.length);
        this.emitCommentary('planning', `Execution plan captured: ${subtasks.length} subtasks`);
        plan = {
          planId: `plan_${taskId}`,
          stack: Array.isArray(bestPlan.stack) && bestPlan.stack.length ? bestPlan.stack : ['Node.js', 'TypeScript'],
          architecture: typeof bestPlan.architecture === 'string' && bestPlan.architecture ? bestPlan.architecture : 'MVP architecture',
          subtasks,
          estimatedDuration: subtasks.length * 3000,
          totalSubtasks: subtasks.length,
        };
      } else {
        console.log('[PlannerAgent] No usable subtasks after filtering, using fallback plan. Last error:', lastError?.message);
        this.emitCommentary('planning', 'Could not extract a plan from the model — using generic fallback');
        plan = this.fallbackPlan(taskId, goal, contract);
      }
    } else {
      console.log('[PlannerAgent] No plan extracted from any attempt, using fallback plan. Last error:', lastError?.message);
      this.emitCommentary('planning', 'Could not extract a plan from the model — using generic fallback');
      plan = this.fallbackPlan(taskId, goal, contract);
    }

    // Create manifest with the plan
    const content = JSON.stringify(plan, null, 2);
    {
      const parsed = JSON.parse(content);
      if (parsed.subtasks.length !== plan.totalSubtasks) {
        console.warn(`[PlannerAgent] execution-plan.json subtask count mismatch: file has ${parsed.subtasks.length} subtasks but plan.totalSubtasks is ${plan.totalSubtasks}`);
      }
    }
    return this.createManifest(contract.subtaskId, [{ filePath: `.omniflow/tasks/${taskId}/execution-plan.json`, content, hash: this.hash(content) }], plan.architecture);
  }

  private extractPlanJson(raw: string | undefined): any | null {
    if (!raw) return null;

    const tryParse = (s: string): any | null => {
      try {
        const parsed = JSON.parse(s);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    };

    // 1) Direct parse
    const direct = tryParse(raw);
    if (direct) return direct;

    // 2) Strip ```json ... ``` fences then parse
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      const fenced = tryParse(fenceMatch[1].trim());
      if (fenced) return fenced;
    }

    // 3) Brace-depth scanner: find the first balanced { ... } object
    const start = raw.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else {
          if (ch === '"') inString = true;
          else if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = raw.slice(start, i + 1);
              const parsed = tryParse(candidate);
              if (parsed) return parsed;
              break;
            }
          }
        }
      }
    }

    return null;
  }

  private defaultSubtask(taskId: string, goal: string, contract: HandoffContract) {
    return {
      subtaskId: `build_${taskId}_0`,
      agentRole: 'coder' as const,
      description: `Build MVP for: ${goal.slice(0, 60)}`,
      successCriteria: ['File created'],
      artifactTargets: [{ filePath: 'generated/app.ts', contentType: 'code' as const }],
      contextPacket: contract.contextPacket,
    };
  }

  private fallbackPlan(taskId: string, goal: string, contract: HandoffContract): ExecutionPlan {
    const g = goal.toLowerCase();
    let subtasks: any[] = [];
    let stack = ['Node.js', 'TypeScript'];
    let architecture = 'MVP architecture';

    // Analyze goal type and generate appropriate subtasks
    const projectType = this.analyzeProjectType(g);
    
    // Base subtasks for any project
    const baseSubtasks = [
      {
        subtaskId: `build_${taskId}_0`,
        agentRole: 'coder' as const,
        description: 'Create package.json with project dependencies',
        successCriteria: ['File created', 'Valid JSON'],
        artifactTargets: [{ filePath: 'generated/package.json', contentType: 'code' as const }],
        contextPacket: contract.contextPacket,
      },
      {
        subtaskId: `build_${taskId}_1`,
        agentRole: 'coder' as const,
        description: 'Create TypeScript configuration',
        successCriteria: ['File created', 'Valid config'],
        artifactTargets: [{ filePath: 'generated/tsconfig.json', contentType: 'code' as const }],
        contextPacket: contract.contextPacket,
      },
    ];

    // Add project-specific subtasks
    if (projectType === 'api') {
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create main server entry point',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/index.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create API routes/handlers',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/routes.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create README with setup instructions',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      stack = ['Node.js', 'TypeScript', 'Express'];
      architecture = 'REST API with modular handlers';
    } else if (projectType === 'bot') {
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create bot entry point with command handlers',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/bot.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create command handlers module',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/commands.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create environment configuration template',
          successCriteria: ['File created'],
          artifactTargets: [{ filePath: 'generated/.env.example', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_5`,
          agentRole: 'coder' as const,
          description: 'Create README with bot setup instructions',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      stack = ['Node.js', 'TypeScript', 'Bot Framework'];
      architecture = 'Bot with modular command handling';
    } else if (projectType === 'web') {
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create main HTML entry point',
          successCriteria: ['File created', 'Valid HTML'],
          artifactTargets: [{ filePath: 'generated/index.html', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create main application logic',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/app.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create README with setup instructions',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      stack = ['Node.js', 'TypeScript', 'HTML5'];
      architecture = 'Web application with modular logic';
    } else if (projectType === 'library') {
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create main library entry point',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/index.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create core module implementation',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/core.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create README with usage examples',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      stack = ['Node.js', 'TypeScript'];
      architecture = 'Reusable library with modular exports';
    } else if (projectType === 'python') {
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create main entry point (Python)',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/main.py', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create core implementation module (Python)',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/core.py', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create requirements.txt and README with setup instructions',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      stack = ['Python', 'pip'];
      architecture = 'Python modular project';
    } else {
      // Generic project
      subtasks = [
        ...baseSubtasks,
        {
          subtaskId: `build_${taskId}_2`,
          agentRole: 'coder' as const,
          description: 'Create main entry point',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/index.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_3`,
          agentRole: 'coder' as const,
          description: 'Create core implementation module',
          successCriteria: ['File created', 'Valid syntax'],
          artifactTargets: [{ filePath: 'generated/src/core.ts', contentType: 'code' as const }],
          contextPacket: contract.contextPacket,
        },
        {
          subtaskId: `build_${taskId}_4`,
          agentRole: 'coder' as const,
          description: 'Create README with setup instructions',
          successCriteria: ['README exists'],
          artifactTargets: [{ filePath: 'generated/README.md', contentType: 'doc' as const }],
          contextPacket: contract.contextPacket,
        },
      ];
      architecture = 'Generic modular project';
    }

    return {
      planId: `plan_${taskId}`,
      stack,
      architecture: `${architecture} - ${goal.slice(0, 60)}`,
      subtasks,
      estimatedDuration: subtasks.length * 4000,
      totalSubtasks: subtasks.length,
    };
  }

  private analyzeProjectType(goal: string): string {
    if (goal.includes('api') || goal.includes('backend') || goal.includes('server') || goal.includes('service')) {
      return 'api';
    }
    if (goal.includes('bot') || goal.includes('telegram') || goal.includes('discord') || goal.includes('slack')) {
      return 'bot';
    }
    if (goal.includes('web') || goal.includes('site') || goal.includes('landing') || goal.includes('frontend') || goal.includes('ui')) {
      return 'web';
    }
    if (goal.includes('library') || goal.includes('package') || goal.includes('sdk') || goal.includes('module')) {
      return 'library';
    }
    if (goal.includes('python') || goal.includes('скрипт') || goal.includes('генериру') || goal.includes('видео') || goal.includes('video') || goal.includes('ml') || goal.includes('data') || goal.includes('ai pipeline') || goal.includes('нейро')) {
      return 'python';
    }
    return 'generic';
  }
}
