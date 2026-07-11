import type { WebviewBridge } from './EventBus';
import { EventBus } from './EventBus';
import { PhaseEngine } from './PhaseEngine';
import { WorkingMemory } from '../memory/WorkingMemory';
import { LedgerMemory } from '../memory/LedgerMemory';
import { HierarchicalMemory } from '../memory/HierarchicalMemory';
import { MemoryFacade } from '../memory/MemoryFacade';
import { ClarifierAgent } from '../agents/ClarifierAgent';
import { ResearchAgent } from '../agents/ResearchAgent';
import { PlannerAgent } from '../agents/PlannerAgent';
import { CoderAgent } from '../agents/CoderAgent';
import { ChatAgent } from '../agents/ChatAgent';
import { AuditAgent } from '../agents/AuditAgent';
import { SecurityAgent } from '../agents/SecurityAgent';
import { VerificationAgent } from '../agents/VerificationAgent';
import { ClineAgentWrapper } from '../agents/ClineAgentWrapper';
import { ContextAgent } from '../agents/ContextAgent';
import { ExecutionRouter } from '../core/ExecutionRouter';
import { ArtifactManager } from '../artifacts/ArtifactManager';
import { ModelRouter } from '../routing/ModelRouter';
import { ToolManager } from './ToolManager';
import { SandboxTool } from '../shell/SandboxTool';
import { SemanticEditor } from '../shell/SemanticEditor';
import { ModelIndexer } from '../routing/ModelIndexer';
import { ConfigManager } from '../config/ConfigManager';
import { setLLMCallListener } from '../routing/LLMLogger';
import { CrossPlatformShell } from '../shell/CrossPlatformShell';
import { ResilientModelRouter } from './ResilientModelRouter';
import { RouterHealthMonitor } from './RouterHealthMonitor';
import { ToolRegistry, createMemoryTools, createArtifactTools, createHelpTools, createConsultTools } from './ToolRegistry';
import { AgentConsultant } from './AgentConsultant';
import type { ConsultFn } from './AgentConsultant';
import { AgentRuntime } from './AgentRuntime';
import { ContextGovernor } from './ContextGovernor';
import { LayeredPromptBuilder, createDefaultPromptBuilder } from './LayeredPromptBuilder';
import { HarnessEvaluator } from './HarnessEvaluator';
import { AgentSupervisor } from './AgentSupervisor';
import { TaskCompass } from './TaskCompass';
import { PromptOrchestrator } from './PromptOrchestrator';
import { RoleSelector } from './RoleSelector';
import { IntentRouter, type IntentDecision, type OmniIntent } from './IntentRouter';
import {
  createPipelineContext,
  intakePhase,
  researchPhase,
  planningPhase,
  runCodersParallel,
  runBuildVerifyLoop,
  selfPromptPhase,
  contextEnrichPhase,
  deliverPhase,
  type PipelineHost,
  type PipelineServices,
} from '../pipeline';
import type {
  Phase,
  AgentRole,
  AgentStatus,
  AgentGraphNode,
  AgentGraphEdge,
  ClarifyingAnswer,
  ClarifyingQuestion,
  UserGoalPacket,
  HandoffContract,
  DeliveryReport,
  WorkspaceSnapshot,
  ApprovalResponse,
} from '../../shared/types';
import { TIER_PHASE_MANIFEST } from '../pipeline/pipelineManifest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

type QuestionResolver = (answers: unknown) => void;

const AGENT_LAYOUT: Record<string, { x: number; y: number }> = {
  orchestrator: { x: 400, y: 40 },
  clarifier: { x: 120, y: 140 },
  researcher: { x: 280, y: 140 },
  planner: { x: 520, y: 140 },
  coder: { x: 200, y: 280 },
  auditor: { x: 400, y: 280 },
  security: { x: 600, y: 280 },
  verifier: { x: 400, y: 400 },
};

const PIPELINE_EDGES: AgentGraphEdge[] = [
  { id: 'e1', source: 'orchestrator', target: 'clarifier', animated: true },
  { id: 'e2', source: 'clarifier', target: 'researcher', animated: true },
  { id: 'e3', source: 'researcher', target: 'planner', animated: true },
  { id: 'e4', source: 'planner', target: 'coder', animated: true },
  { id: 'e5', source: 'coder', target: 'auditor', animated: true },
  { id: 'e6', source: 'auditor', target: 'security', animated: true },
  { id: 'e7', source: 'security', target: 'verifier', animated: true },
  { id: 'e8', source: 'verifier', target: 'orchestrator', animated: true },
];

interface ApiKeyPromptResponse {
  requestId: string;
  action: 'proceed' | 'skip' | 'fallback';
  keys?: Record<string, string>;
}

export class OmniOrchestrator {
  private phaseEngine: PhaseEngine;
  private eventBus: EventBus;
  private memory: WorkingMemory;
  private ledger: LedgerMemory;
  private artifacts: ArtifactManager;
  private router: ModelRouter;
  private modelIndexer!: ModelIndexer;
  private resilientRouter: ResilientModelRouter;
  private healthMonitor: RouterHealthMonitor;
  private toolRegistry: ToolRegistry;
  private contextGovernor: ContextGovernor;
  private promptBuilder: LayeredPromptBuilder;
  private harnessEvaluator: HarnessEvaluator;
  private supervisor: AgentSupervisor;
  private useSupervisor = false;
  private apiKeys: Record<string, string>;
  private taskCompass: TaskCompass;
  private promptOrchestrator: PromptOrchestrator;
  private roleSelector = new RoleSelector();
  /** Loaded project docs (AGENTS.md / OMNI.md) used to ground agents. */
  private projectDocs: { agentsMd?: string; omniMd?: string } = {};

  /** Phase 3: shared memory and context enrichment */
  private sharedMemory: MemoryFacade;
  private contextAgent: ContextAgent;

  private clarifier: ClarifierAgent;
  private researcher: ResearchAgent;
  private toolManager!: ToolManager;
  private sandboxTool!: SandboxTool;
  private semanticEditor!: SemanticEditor;
  private planner: PlannerAgent;
  private coder: CoderAgent;
  private auditor: AuditAgent;
  private security: SecurityAgent;
  private verifier: VerificationAgent;
  private agentConsultant!: AgentConsultant;
  private executionRouter: ExecutionRouter;
  private intentRouter!: IntentRouter;
  private chatAgent!: ChatAgent;
  private clineAvailable = false;

  private agentStatuses = new Map<AgentRole, AgentStatus>();
  private spawnedAgents = new Set<AgentRole>(['orchestrator']);
  private runtimeEdges: AgentGraphEdge[] = [];
  private cancelRequested = false;
  private isRunning = false;
  private isPaused = false;
  private static activeInstance: OmniOrchestrator | null = null;
  private startTime = 0;
  private questionResolver: QuestionResolver | null = null;
  private pendingQuestions: ClarifyingQuestion[] = [];
  private currentTier: 'LOW' | 'MEDIUM' | 'HIGH' | undefined = undefined;
  private approvalResolver?: (r: ApprovalResponse) => void;
  private approvalTimeout?: ReturnType<typeof setTimeout>;
  private apiKeyPromptResolver?: (r: ApiKeyPromptResponse) => void;
  private currentApprovalRequestId?: string;

  constructor(private workspaceRoot: string) {
    const config = ConfigManager.load();
    this.apiKeys = ConfigManager.toApiKeys(config);

    // Log loaded API keys for debugging
    console.log('OmniOrchestrator: Loaded API keys:', {
      openrouter: this.apiKeys.openrouter ? '***' + this.apiKeys.openrouter.slice(-4) : 'NOT SET',
      'kilo-gateway': this.apiKeys['kilo-gateway'] ? '***' + this.apiKeys['kilo-gateway'].slice(-4) : 'NOT SET',
      codik: this.apiKeys.codik ? '***' + this.apiKeys.codik.slice(-4) : 'NOT SET',
      preferredProvider: config.preferredProvider,
      budget: config.budget,
    });

    this.eventBus = new EventBus();
    this.phaseEngine = new PhaseEngine(this.eventBus);
    this.memory = new WorkingMemory();
    this.ledger = new LedgerMemory(workspaceRoot);
    this.artifacts = new ArtifactManager(workspaceRoot);

    // Phase 3: shared memory facade (singleton per workspace)
    this.sharedMemory = MemoryFacade.getInstance(workspaceRoot);
    this.contextAgent = new ContextAgent(this.sharedMemory, this.artifacts, this.eventBus);

    // Initialize resilient router with health monitoring
    this.router = new ModelRouter(config.budget, this.workspaceRoot);
    this.modelIndexer = new ModelIndexer({ eventBus: this.eventBus });
    this.router.setPreferredProvider(config.preferredProvider);
    this.router.setApiKeys(this.apiKeys);

    // ToolManager is now live: provisions agent tooling (exa/tavily/puppeteer/playwright) into the workspace.
    this.sandboxTool = new SandboxTool({ workspaceRoot: this.workspaceRoot, eventBus: this.eventBus });
    this.semanticEditor = new SemanticEditor(this.workspaceRoot);
    this.toolManager = new ToolManager(this.eventBus, this.sandboxTool, this.workspaceRoot);
    this.useSupervisor = config.useSupervisor;

    this.healthMonitor = new RouterHealthMonitor(this.eventBus);
    this.router.setHealthMonitor(this.healthMonitor);
    this.resilientRouter = new ResilientModelRouter(
      this.eventBus,
      this.router,
      new Map(), // fallback routers can be added here
      {
        maxRetries: 3,
        retryDelayMs: 1000,
        providers: ['openrouter', 'kilo-gateway', 'codik', 'ollama'],
      },
      this.healthMonitor
    );

    // Initialize tool registry and context governor
    this.toolRegistry = new ToolRegistry(this.eventBus);

    // Phase 3: register memory, artifact, and help tools
    const memTools = createMemoryTools(this.sharedMemory);
    for (const [k, v] of Object.entries(memTools.executors)) {
      this.toolRegistry.register(k, memTools.tools.find(t => t.name === k)!, v);
    }
    const artTools = createArtifactTools(this.artifacts);
    for (const [k, v] of Object.entries(artTools.executors)) {
      this.toolRegistry.register(k, artTools.tools.find(t => t.name === k)!, v);
    }
    const helpTools = createHelpTools(this.toolRegistry);
    for (const [k, v] of Object.entries(helpTools.executors)) {
      this.toolRegistry.register(k, helpTools.tools.find(t => t.name === k)!, v);
    }
    this.contextGovernor = new ContextGovernor(this.eventBus, this.router, {
      type: 'adaptive',
      driftThreshold: 0.3,
    });
    this.promptBuilder = createDefaultPromptBuilder();
    this.harnessEvaluator = new HarnessEvaluator(this.eventBus, this.ledger);
    this.taskCompass = new TaskCompass('', { type: 'adaptive', driftThreshold: 0.6 });
    
    // Initialize PromptOrchestrator for self-prompting loops
    this.promptOrchestrator = new PromptOrchestrator({
      maxRounds: 3,
      convergenceThreshold: 0.8,
      eventBus: this.eventBus,
    });

    // Initialize agents with resilient router
    this.clarifier = new ClarifierAgent(this.resilientRouter, this.apiKeys, this.eventBus);
    this.researcher = new ResearchAgent(this.resilientRouter, this.apiKeys, this.eventBus);
    this.planner = new PlannerAgent(this.resilientRouter, this.apiKeys, this.eventBus);
    this.coder = new CoderAgent(this.resilientRouter, this.apiKeys, this.eventBus, this.sharedMemory);
    this.auditor = new AuditAgent(this.resilientRouter, this.apiKeys, this.eventBus, config.llmAudit);
    this.security = new SecurityAgent(this.resilientRouter, this.apiKeys, this.eventBus, config.llmSecurity);
    this.verifier = new VerificationAgent(this.resilientRouter, this.apiKeys, this.eventBus);

    // Inject shared memory into coder for recall_skill / semantic_search
    this.coder.setMemory(this.sharedMemory);

    this.wireAgentInfrastructure();

    this.agentConsultant = new AgentConsultant(
      { researcher: this.researcher, planner: this.planner, coder: this.coder, clarifier: this.clarifier, security: this.security },
      (req, prompt, sp, keys) => this.resilientRouter.call(req, prompt, sp, keys),
      () => this.apiKeys,
      this.eventBus
    );
    this.coder.setConsultFn(this.agentConsultant.consult.bind(this.agentConsultant));
    this.planner.setConsultFn(this.agentConsultant.consult.bind(this.agentConsultant));
    this.researcher.setConsultFn(this.agentConsultant.consult.bind(this.agentConsultant));
    this.security.setConsultFn(this.agentConsultant.consult.bind(this.agentConsultant));

    // LLM-first intent routing: the model evaluates the request and chooses the
    // path (chat vs build), replacing the previously hardcoded `intent: 'build'`.
    this.intentRouter = new IntentRouter(this.router, this.apiKeys, this.eventBus);
    this.chatAgent = new ChatAgent(this.resilientRouter, this.apiKeys, this.eventBus, this.sharedMemory);
    this.chatAgent.setConsultFn(this.agentConsultant.consult.bind(this.agentConsultant));

    // Register agents with PromptOrchestrator for self-prompting
    this.promptOrchestrator.registerAgent(this.clarifier);
    this.promptOrchestrator.registerAgent(this.researcher);
    this.promptOrchestrator.registerAgent(this.planner);
    this.promptOrchestrator.registerAgent(this.coder);

    const clineWrapper = this.createClineWrapperSafely();

    this.executionRouter = new ExecutionRouter({
      cline: clineWrapper,
      legacy: this.coder,
    });

    this.supervisor = new AgentSupervisor(this.eventBus, this.phaseEngine);
    if (this.useSupervisor) {
      this.supervisor.setUseSupervisor(true);
    }

    this.initAgentStatuses();
    this.wireLlmTelemetry();

    this.eventBus.on('AGENT_CONSULT', (ev) => {
      const p = ev.payload as { from: AgentRole; to: AgentRole };
      this.spawnedAgents.add(p.from);
      this.spawnedAgents.add(p.to);
      this.runtimeEdges.push({
        id: `consult-${p.from}-${p.to}-${Date.now()}`,
        source: p.from,
        target: p.to,
        animated: true,
      });
      this.pushGraph();
    });
  }

  private wireAgentInfrastructure(): void {
    const llmAgents = [this.clarifier, this.researcher, this.planner, this.coder];
    for (const agent of llmAgents) {
      agent.setPromptBuilder(this.promptBuilder);
      agent.setSharedTools(this.sandboxTool, this.semanticEditor);
    }
  }

  /** Pipeline host adapter — phases call orchestrator hooks without tight coupling. */
  private createPipelineHost(): PipelineHost {
    return {
      workspaceRoot: this.workspaceRoot,
      eventBus: this.eventBus,
      phaseEngine: this.phaseEngine,
      chat: (role, content) => this.chat(role, content),
      setAgent: (id, status, message) => this.setAgent(id, status, message),
      transitionPhase: (phase) => this.phaseEngine.transitionTo(phase),
      runPhaseSafely: (fn, label, maxRetries) => this.runPhaseSafely(fn, label, maxRetries),
      assertNotCancelled: () => this.assertNotCancelled(),
      isCancelled: () => this.cancelRequested,
      requestApiKeyPrompt: (payload) => this.requestApiKeyPrompt(payload),
      askClarifyingQuestions: (questions) => this.askClarifyingQuestions(questions),
      refineGoal: (goal, answers) => this.refineGoal(goal, answers),
      requestApproval: (payload) => this.requestApproval(payload),
      emitArtifact: (taskId, filePath, agentId) => this.emitArtifact(taskId, filePath, agentId),
      emitPhaseLifecycle: (phase, event, extra) => this.emitPhaseLifecycle(phase, event, extra),
      getElapsedMs: () => Date.now() - this.startTime,
      scanWorkspace: () => this.scanWorkspace(),
      draftProjectDocs: (goal) => this.draftProjectDocs(goal),
      readProjectDocs: () => this.readProjectDocs(),
    };
  }

  private emitPhaseLifecycle(
    phase: Phase,
    event: 'started' | 'completed' | 'skipped',
    extra?: Record<string, unknown>
  ): void {
    const suffix = [
      extra?.durationMs != null ? `${extra.durationMs}ms` : '',
      extra?.reason ? String(extra.reason) : '',
      extra?.taskId ? `task=${extra.taskId}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase,
        thought: `PHASE_${event.toUpperCase()}: ${phase}${suffix ? ` (${suffix})` : ''}`,
        timestamp: Date.now(),
      },
    });
  }

  private createPipelineServices(): PipelineServices {
    return {
      researcher: this.researcher,
      clarifier: this.clarifier,
      planner: this.planner,
      toolManager: this.toolManager,
      memory: this.memory,
      sharedMemory: this.sharedMemory,
      taskCompass: this.taskCompass,
      apiKeys: this.apiKeys,
      runCoders: (plan, ctx) =>
        runCodersParallel(
          {
            workspaceRoot: this.workspaceRoot,
            useSupervisor: this.useSupervisor,
            executionRouter: this.executionRouter,
            supervisor: this.supervisor,
            emitArtifact: (taskId, filePath, agentId) => this.emitArtifact(taskId, filePath, agentId),
          },
          plan,
          ctx
        ),
      auditor: this.auditor,
      security: this.security,
      verifier: this.verifier,
      promptOrchestrator: this.promptOrchestrator,
      contextAgent: this.contextAgent,
      artifacts: this.artifacts,
      ledger: this.ledger,
      roleSelector: this.roleSelector,
      modelIndexer: this.modelIndexer,
      router: this.router,
    };
  }

  private createClineWrapperSafely(): ClineAgentWrapper {
    try {
      const wrapper = new ClineAgentWrapper({
        router: this.router,
        apiKeys: this.apiKeys,
        eventBus: this.eventBus,
        workspaceRoot: this.workspaceRoot,
      });
      this.clineAvailable = true;
      return wrapper;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.clineAvailable = false;
      this.chat(
        'system',
        `⚠ Cline runtime unavailable: ${message}. Build phase will use legacy executor.`
      );
      // Fallback: create a dummy wrapper that always falls back to legacy.
      // The router handles fallback, so this path is mostly for observability.
      return new ClineAgentWrapper({
        router: this.router,
        apiKeys: this.apiKeys,
        eventBus: this.eventBus,
        workspaceRoot: this.workspaceRoot,
      });
    }
  }

  private refreshConfig(): void {
    const config = ConfigManager.load();
    this.apiKeys = ConfigManager.toApiKeys(config);
    this.router.setPreferredProvider(config.preferredProvider);
    this.router.setBudget(config.budget);
    this.router.setApiKeys(this.apiKeys);
    this.router.setCustomOrchestratorModel(config.orchestratorModel);
    this.useSupervisor = config.useSupervisor;
    this.supervisor.setUseSupervisor(config.useSupervisor);
    this.clarifier.setApiKeys(this.apiKeys);
    this.researcher.setApiKeys(this.apiKeys);
    this.planner.setApiKeys(this.apiKeys);
    this.coder.setApiKeys(this.apiKeys);
    const resolved = this.router.getResolvedProvider(this.apiKeys);
    const hasKey = Boolean(
      config.openrouterApiKey || config.kiloGatewayApiKey || config.codikApiKey
    );
    this.eventBus.emit({
      type: 'PROVIDER_STATUS',
      payload: {
        provider: resolved,
        hasKey,
        budget: config.budget,
      },
    });
    if (hasKey) {
      this.chat('system', `LLM provider: ${resolved} (preferred: ${config.preferredProvider})`);
    }

    // Emit health status
    const healthStatuses = this.healthMonitor.getAllStatuses();
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: 'intake',
        thought: `Health monitor initialized with ${healthStatuses.length} tracked providers`,
        timestamp: Date.now(),
      },
    });
  }

  private wireLlmTelemetry(): void {
    setLLMCallListener((info) => {
      this.eventBus.emit({ type: 'LLM_CALL', payload: info });

      if (info.usedFallback) {
        const provider = info.provider;
        const model = info.model;
        const err = info.error ?? '';

        // Friendly Kilo-specific messaging for 402 / free-model switching.
        const isKilo402 = provider === 'fallback' || provider === 'kilo-gateway'
          ? err.includes('HTTP 402') || err.toLowerCase().includes('credits required') || err.toLowerCase().includes('paid model')
          : false;

        if (isKilo402) {
          this.chat(
            'system',
            `⚠ Kilo Gateway: нет credits для модели "${model}".\n` +
              `Пополните баланс или переключитесь на free-модель для Kilo (в настройках: budget=free / используйте доступные :free модели).\n` +
              `Сейчас выполняется offline fallback (${info.agentRole}).`
          );
        } else {
          this.chat('system', `⚠ LLM fallback (${info.agentRole}): ${info.error ?? 'offline mode'}`);
        }
      } else {
        this.chat('system', `✓ ${info.provider}/${info.model} responded (${info.agentRole})`);
      }
    });
  }

  setWebviewBridge(bridge: WebviewBridge): void {
    this.eventBus.setWebviewBridge(bridge);
  }

  submitClarifyingAnswers(answers: ClarifyingAnswer[]): void {
    if (this.questionResolver) {
      this.questionResolver(answers);
      this.questionResolver = null;
    }
  }

  submitApiKeyPrompt(resp: ApiKeyPromptResponse): void {
  if (this.apiKeyPromptResolver) {
    const r = this.apiKeyPromptResolver;
    this.apiKeyPromptResolver = undefined;
    r(resp);
  }
}

async requestApiKeyPrompt(payload: { tools: { toolName: string; envVar: string; signupUrl: string }[]; fallbackAvailable: boolean; reason: string }): Promise<ApiKeyPromptResponse> {
  const requestId = 'apikey_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  this.eventBus.emit({
    type: 'API_KEY_PROMPT',
    payload: { requestId, ...payload },
  });
  return new Promise((resolve) => {
    this.apiKeyPromptResolver = resolve;
  });
}

  submitApproval(resp: ApprovalResponse): void {
    if (this.approvalTimeout) clearTimeout(this.approvalTimeout);
    if (this.approvalResolver) {
      const r = this.approvalResolver;
      this.approvalResolver = undefined;
      r(resp);
    }
  }

  async requestApproval(payload: { title: string; tier: string; architecture: string; stack: string[]; acceptanceCriteria: string[]; files: string[]; summary: string }): Promise<ApprovalResponse> {
    const requestId = 'approval_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    this.currentApprovalRequestId = requestId;
    this.chat('system', '⏳ Awaiting plan approval…');
    this.eventBus.emit({
      type: 'APPROVAL_REQUIRED',
      payload: { requestId, ...payload },
    });
    return new Promise((resolve) => {
      this.approvalResolver = resolve;
      this.approvalTimeout = setTimeout(() => {
        this.chat('system', '⏰ Approval timeout — auto-approving to keep the pipeline moving.');
        const r = this.approvalResolver;
        this.approvalResolver = undefined;
        this.approvalTimeout = undefined;
        if (r) r({ approved: true, feedback: '(auto-approved after timeout)', requestId });
      }, 600000);
    });
  }

  getPendingQuestions(): ClarifyingQuestion[] {
    return this.pendingQuestions;
  }

  async start(rawGoal: string, mode?: string): Promise<DeliveryReport> {
    if (this.isRunning) throw new Error('Orchestrator already running');
    if (OmniOrchestrator.activeInstance && OmniOrchestrator.activeInstance.isRunning) {
      throw new Error('Another Omni orchestration is already running');
    }
    this.isRunning = true;
    OmniOrchestrator.activeInstance = this;
    this.cancelRequested = false;
    this.spawnedAgents = new Set<AgentRole>(['orchestrator']);
    this.runtimeEdges = [];
    this.startTime = Date.now();
    this.phaseEngine.reset();
    this.memory.clear();
    // Phase 3: clear enrichment cache for fresh run
    this.contextAgent.clearCache();
    this.refreshConfig();
    this.initAgentStatuses();
    this.emitStateUpdate();

    // Initialize TaskCompass with the goal
    this.taskCompass = new TaskCompass(rawGoal, { type: 'adaptive', driftThreshold: 0.6 });
    // Publish this single compass as the shared instance so every AgentRuntime
    // (researcher / planner / coder) reuses the SAME compass instead of creating
    // its own — the whole task stays on one compass.
    TaskCompass.setSharedInstance(this.taskCompass);

    this.chat('system', `Starting Omni orchestration on ${CrossPlatformShell.platformInfo()}`);
    this.chat('user', rawGoal);

    // ── LLM-first intent routing ───────────────────────────────────────────
    // The LLM evaluates the request FIRST and decides the path. This is the
    // model-driven loop pattern used by Claude Code / Codex / Devin / Kilo:
    // the harness does not assume a build — the model reads the prompt and
    // chooses (e.g. answer directly vs. run the builder). The previous code
    // hardcoded `intent: 'build'`, so even "who are you" spawned coders.
    this.chat('system', 'Evaluating your request (LLM intent routing)…');
    const decision: IntentDecision = await this.intentRouter.classify(rawGoal, {
      mode,
      workspaceRoot: this.workspaceRoot,
    });
    this.chat(
      'system',
      `Intent → ${decision.intent} (confidence ${decision.confidence.toFixed(2)}` +
        `${decision.heuristic ? ', heuristic fallback' : ''}). ${decision.reasoning}`
    );

    const BUILD_INTENTS = new Set<OmniIntent>(['code', 'debug', 'refactor', 'migrate']);
    const isBuild = BUILD_INTENTS.has(decision.intent) || (decision.intent === 'unknown' && decision.requiresBuild);

    // Non-build intents (chat / ask / research-without-build / unknown-no-build)
    // are answered directly — no coder, no build/verify loop.
    if (!isBuild) {
      return await this.runChatMode(rawGoal, decision);
    }

    try {
// Initialize pipeline context with minimal data (will be populated by intakePhase)
       const taskId = `task_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
       const pipelineCtx = createPipelineContext({
         taskId,
         rawGoal,
         workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
         goalPacket: {
           taskId,
           goal: rawGoal,
           intent: 'build',
           complexity: 'low',
           workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
         },
         tier: 'LOW',
         phases: ['intake'], // Start with just intake, will update after intake phase
       });
       pipelineCtx.startedAt = this.startTime;

       const pipelineHost = this.createPipelineHost();
       const pipelineServices = this.createPipelineServices();

// INTAKE: scan workspace, bootstrap docs, create goal packet, triage
       this.assertNotCancelled();
       await this.waitWhilePaused();
       await intakePhase.run(pipelineHost, pipelineCtx, pipelineServices);
       this.currentTier = pipelineCtx.tier;

      // DYNAMIC PHASE SELECTION: Use RoleSelector to determine which phases to run
      const roleSelector = new RoleSelector();
      const roleSelection = roleSelector.select(pipelineCtx.goalPacket.goal, pipelineCtx.goalPacket.complexity);
      
      // Update the pipeline context with the dynamically determined tier and self-prompting flag
      pipelineCtx.tier = roleSelection.tier;
      pipelineCtx.useSelfPrompting = roleSelection.useSelfPrompting;
      
      // Build the complete phases array based on role selection
      // Start with intake (already completed), then add selected phases, then deliver (always last)
      const phasesToRun: Phase[] = ['intake'];
      
      // Add phases from role selection (these come from the ROLE_TO_PHASE mapping in RoleSelector)
      phasesToRun.push(...roleSelection.phases);
      
      // Add self-prompt phase if indicated by role selection
      if (roleSelection.useSelfPrompting) {
        phasesToRun.push('self-prompt');
      }
      
      // Always end with deliver
      phasesToRun.push('deliver');
      
      // Update the pipeline context with the final phases list
      pipelineCtx.phases = phasesToRun;

      // Create phase instance map for easy lookup
      const phaseInstances: Record<string, any> = {
        research: researchPhase,
        'self-prompt': selfPromptPhase,
        planning: planningPhase,
        'context-enrich': contextEnrichPhase,
        deliver: deliverPhase
      };

      // Execute phases in order (skipping intake as it's already done)
      for (const phaseId of phasesToRun) {
        // Skip intake as we already ran it
        if (phaseId === 'intake') continue;

        this.assertNotCancelled();
        await this.waitWhilePaused();

        // Handle build/audit/security/verify phases together via runBuildVerifyLoop
        if (['build', 'audit', 'security', 'verify'].includes(phaseId)) {
          // We'll handle all build-related phases together in one go
          continue;
        }

        // Handle standard phases
        const phaseInstance = phaseInstances[phaseId];
        if (phaseInstance) {
          await phaseInstance.run(pipelineHost, pipelineCtx, pipelineServices);
        }
      }

      // BUILD → AUDIT → SECURITY → VERIFY (with retry loop)
      // Check if any of these phases are selected
      const buildRelatedPhases: Phase[] = ['build', 'audit', 'security', 'verify'];
      const shouldRunBuildPhase = buildRelatedPhases.some((phase): phase is Phase => phasesToRun.includes(phase));
      if (shouldRunBuildPhase) {
        this.assertNotCancelled();
        await this.waitWhilePaused();
        await runBuildVerifyLoop(pipelineHost, pipelineCtx, pipelineServices, {
          maxRetries: 3,
          onBeforeRetry: () => this.initAgentStatuses(),
        });
      }

      // DELIVER: Always run the deliver phase to wrap up
      this.assertNotCancelled();
      await this.waitWhilePaused();
      const deliverOutcome = await deliverPhase.run(pipelineHost, pipelineCtx, pipelineServices);
      if (!deliverOutcome.report) {
        throw new Error('Deliver phase did not produce a report');
      }
      return deliverOutcome.report;
    } catch (err) {
      this.setAgent('orchestrator', 'error', String(err));
      this.eventBus.emit({
        type: 'ERROR_OCCURRED',
        payload: { error: err instanceof Error ? err.message : String(err), phase: this.phaseEngine.getCurrentPhase(), recoverable: false },
      });
      throw err;
    } finally {
      this.sharedMemory.flushToDisk(true);
      this.isRunning = false;
      OmniOrchestrator.activeInstance = null;
    }
  }

  private route(taskId: string, goalPacket: UserGoalPacket) {
    // Dynamic role selection (no longer a hardcoded switch): complexity + goal signals
    // decide which agents run. HIGH tasks use the full pipeline + self-prompting.
    return this.roleSelector.select(goalPacket.goal, goalPacket.complexity);
  }

  /**
   * Direct-answer path for non-build intents (chat / ask / research questions).
   * Runs a READ-ONLY model-driven loop (ChatAgent) so the LLM can still inspect
   * the workspace if helpful, but never enters the coder/build/verify pipeline.
   */
  private async runChatMode(goal: string, decision: IntentDecision): Promise<DeliveryReport> {
    const taskId = `chat_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.setAgent('chat' as AgentRole, 'working', 'Answering in chat mode');
    this.chat('system', 'Chat mode — answering directly (no build pipeline).');
    try {
      const answer = await this.chatAgent.answer(goal, this.workspaceRoot);
      this.chat('assistant', answer);
      this.setAgent('chat' as AgentRole, 'done', 'Answered');
      return {
        taskId,
        artifacts: [],
        verdict: 'PASS',
        durationMs: Date.now() - this.startTime,
        ledgerPath: '',
        runInstructions: '',
        summary: answer,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.chat('system', `Chat failed: ${msg}`);
      this.setAgent('chat' as AgentRole, 'error', msg);
      return {
        taskId,
        artifacts: [],
        verdict: 'FAIL',
        durationMs: Date.now() - this.startTime,
        ledgerPath: '',
        runInstructions: '',
        summary: `Chat mode failed: ${msg}`,
      };
    }
  }

  private parseJsonSafe(text: string): any {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;
    try { return JSON.parse(raw.trim()); } catch { return null; }
  }

  /**
   * For a clean project (no meaningful source files and no AGENTS.md/OMNI.md),
   * propose creating those docs so the agent can rely on them (autonomy).
   * Existing docs are loaded so agents ground their work in them.
   */
  private async maybeBootstrapProject(workspace: WorkspaceSnapshot, goal: string, taskId: string): Promise<void> {
    const meaningful = (workspace.fileTree || []).filter((f) =>
      !/^(node_modules|\.git|\.vscode|\.omniflow|dist|out|build|coverage)$/.test(f) &&
      !f.startsWith('.') &&
      !/\.(png|jpg|jpeg|gif|ico|lock|log)$/i.test(f)
    );
    const hasAgents = fs.existsSync(path.join(this.workspaceRoot, 'AGENTS.md'));
    const hasOmni = fs.existsSync(path.join(this.workspaceRoot, 'OMNI.md'));

    if (meaningful.length > 0 || hasAgents || hasOmni) {
      this.projectDocs = this.readProjectDocs();
      return;
    }

    this.chat('system', 'Чистый проект без файлов — предлагаю создать AGENTS.md и OMNI.md для автономности.');

    const draft = await this.draftProjectDocs(goal);
    const approval = await this.requestApproval({
      title: 'Создать AGENTS.md и OMNI.md?',
      tier: this.currentTier ?? 'LOW',
      architecture: 'Project conventions + memory',
      stack: workspace.techStack,
      acceptanceCriteria: ['AGENTS.md created', 'OMNI.md created'],
      files: ['AGENTS.md', 'OMNI.md'],
      summary: 'Omni сгенерирует файлы конвенций проекта и памяти, чтобы опираться на них при работе.',
    });

    if (approval.approved) {
      const files: Array<[string, string]> = [
        ['AGENTS.md', draft.agentsMd],
        ['OMNI.md', draft.omniMd],
      ];
      for (const [name, content] of files) {
        const full = path.join(this.workspaceRoot, name);
        fs.writeFileSync(full, content, 'utf-8');
        this.emitArtifact(taskId, name, 'orchestrator');
      }
      this.chat('assistant', `Создал AGENTS.md и OMNI.md${approval.feedback ? ' (правки: ' + approval.feedback + ')' : ''}.`);
    }
    this.projectDocs = this.readProjectDocs();
  }

  private async draftProjectDocs(goal: string): Promise<{ agentsMd: string; omniMd: string }> {
    try {
      const res = await this.router.call(
        { phase: 'intake', agentRole: 'clarifier', complexity: 'low' },
        `Generate two markdown docs for a new project.\nGOAL: ${goal}\n\nReturn ONLY JSON: {"agentsMd": string, "omniMd": string}.\n- agentsMd: project conventions, coding style, testing, how to run.\n- omniMd: project overview, goal, key decisions, memory for future sessions.`,
        'You are a project bootstrapper. Return ONLY JSON.',
        this.apiKeys
      );
      const parsed = this.parseJsonSafe(res.content || '');
      return {
        agentsMd: parsed?.agentsMd || `# AGENTS.md\n\n# Conventions\n- Language: TypeScript\n- Style: clear, typed, minimal\n- Tests: include where practical\n\n# Goal\n${goal}\n`,
        omniMd: parsed?.omniMd || `# OMNI.md\n\n# Project\n${goal}\n\n# Memory\n- Generated by Omni bootstrap.\n`,
      };
    } catch {
      return {
        agentsMd: `# AGENTS.md\n\n# Conventions\n- Language: TypeScript\n- Style: clear, typed, minimal\n\n# Goal\n${goal}\n`,
        omniMd: `# OMNI.md\n\n# Project\n${goal}\n\n# Memory\n- Generated by Omni bootstrap.\n`,
      };
    }
  }

  private readProjectDocs(): { agentsMd?: string; omniMd?: string } {
    const docs: { agentsMd?: string; omniMd?: string } = {};
    try {
      const a = path.join(this.workspaceRoot, 'AGENTS.md');
      const o = path.join(this.workspaceRoot, 'OMNI.md');
      if (fs.existsSync(a)) docs.agentsMd = fs.readFileSync(a, 'utf-8');
      if (fs.existsSync(o)) docs.omniMd = fs.readFileSync(o, 'utf-8');
    } catch { /* ignore */ }
    return docs;
  }

  /** Reload API keys from config (e.g. after the user pastes a tool key in the UI) and push to all agents/router. */
  refreshApiKeys(): void {
    this.refreshConfig();
  }

  private askClarifyingQuestions(questions: ClarifyingQuestion[]): Promise<ClarifyingAnswer[]> {
    this.pendingQuestions = questions;
    this.eventBus.emit({ type: 'CLARIFYING_QUESTIONS', payload: { taskId: 'pending', questions } });
    this.chat('system', `⏳ Waiting for ${questions.length} clarifying answer(s) from user…`);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (raw: unknown) => {
        if (timer) clearTimeout(timer);
        this.questionResolver = null;
        this.pendingQuestions = [];
        const answers = this.normalizeClarifyingAnswers(raw);
        for (const a of answers) {
          const q = questions.find((x) => x.id === a.questionId);
          const answer = a.customText || a.selectedOption || '';
          if (q && answer) this.chat('user', `${q.question} → ${answer}`);
        }
        resolve(answers);
      };
      this.questionResolver = finish;
      timer = setTimeout(() => {
        this.chat('system', '⏰ Clarifying-questions timeout — proceeding without user answers.');
        finish([]);
      }, 600000);
    });
  }

  /**
   * Normalize whatever the webview sends for clarifying answers into the
   * canonical ClarifyingAnswer[] shape. Tolerates three legacy/edge forms:
   *  - string[] (older UI): value by question index
   *  - { questionId, value } objects
   *  - { questionId, selectedOption?, customText? } objects (canonical)
   * A value that matches one of the question's options becomes selectedOption,
   * otherwise it becomes customText.
   */
  private normalizeClarifyingAnswers(raw: unknown): ClarifyingAnswer[] {
    const questions = this.pendingQuestions ?? [];
    if (!Array.isArray(raw)) return [];
    const out: ClarifyingAnswer[] = [];
    raw.forEach((a, idx) => {
      if (a == null) return;
      let questionId: string | undefined;
      let value: string | undefined;
      if (typeof a === 'string') {
        questionId = questions[idx]?.id;
        value = a;
      } else if (typeof a === 'object') {
        const o = a as Record<string, unknown>;
        questionId = (typeof o.questionId === 'string' ? o.questionId : questions[idx]?.id) as string | undefined;
        value = (typeof o.value === 'string' ? o.value
          : typeof o.selectedOption === 'string' ? o.selectedOption
          : typeof o.customText === 'string' ? o.customText
          : undefined);
      }
      if (!questionId || !value) return;
      const q = questions.find((x) => x.id === questionId) ?? questions[idx];
      const isOption = !!q && Array.isArray(q.options) && q.options.includes(value);
      out.push({
        questionId,
        selectedOption: isOption ? value : undefined,
        customText: isOption ? undefined : value,
      });
    });
    return out;
  }

  private refineGoal(goal: string, answers: ClarifyingAnswer[]): string {
    if (!answers.length) return goal;

    // Convert clarifications into a more structured, human-readable and model-friendly block.
    const decisions = answers
      .map((a) => {
        const val = a.customText || a.selectedOption || '';
        if (!val) return null;
        return { key: a.questionId, value: val };
      })
      .filter((x): x is { key: string; value: string } => Boolean(x));

    const decisionsText = decisions
      .map((d) => `- ${d.key}: ${d.value}`)
      .join('\n');

    return `${goal}

User decisions (from clarifying questions):
${decisionsText}`.trim();
  }

  private async scanWorkspace(): Promise<WorkspaceSnapshot> {
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
      for (const e of entries.slice(0, 30)) {
        if (e.isFile()) files.push(e.name);
      }
    } catch { /* empty */ }
    const techStack: string[] = [];
    if (fs.existsSync(path.join(this.workspaceRoot, 'package.json'))) techStack.push('Node.js');
    if (files.some((f) => f.endsWith('.ts'))) techStack.push('TypeScript');
    if (files.some((f) => f.endsWith('.py'))) techStack.push('Python');
    return { fileTree: files, hasPackageJson: techStack.includes('Node.js'), hasReadme: fs.existsSync(path.join(this.workspaceRoot, 'README.md')), techStack };
  }

  private initAgentStatuses(): void {
    const roles: AgentRole[] = ['orchestrator', 'clarifier', 'researcher', 'planner', 'coder', 'auditor', 'security', 'verifier'];
    roles.forEach((r) => this.agentStatuses.set(r, 'idle'));
    this.pushGraph();
  }

  private setAgent(id: AgentRole, status: AgentStatus, message?: string): void {
    this.spawnedAgents.add(id);
    this.agentStatuses.set(id, status);
    this.eventBus.emit({ type: 'AGENT_STATUS_UPDATE', payload: { agentId: id, status, message } });
    this.pushGraph();
  }

  private pushGraph(): void {
    const workingAgentIds = new Set<string>();
    this.agentStatuses.forEach((status, id) => {
      if (status === 'working') workingAgentIds.add(id);
    });

    const agents = Array.from(this.spawnedAgents);
    const nodes: AgentGraphNode[] = agents.map((id, index) => {
      const layout = AGENT_LAYOUT[id] ?? {
        x: 80 + (index % 4) * 160,
        y: 60 + Math.floor(index / 4) * 130,
      };
      return {
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        role: id,
        status: this.agentStatuses.get(id) ?? 'idle',
        x: layout.x,
        y: layout.y,
      };
    });

    const pipelineEdges = PIPELINE_EDGES.filter(
      (e) => this.spawnedAgents.has(e.source as AgentRole) && this.spawnedAgents.has(e.target as AgentRole)
    );
    const edges: AgentGraphEdge[] = [...pipelineEdges, ...this.runtimeEdges].map((e) => ({
      ...e,
      animated: workingAgentIds.has(e.source) || workingAgentIds.has(e.target),
    }));

    this.eventBus.emit({ type: 'AGENT_GRAPH_UPDATE', payload: { nodes, edges } });
  }

  requestStop(): void {
    this.cancelRequested = true;
    this.isRunning = false;
    this.isPaused = false;
    const roles: AgentRole[] = ['orchestrator', 'clarifier', 'researcher', 'planner', 'coder', 'auditor', 'security', 'verifier'];
    roles.forEach((r) => this.agentStatuses.set(r, 'idle'));
    this.pushGraph();
    this.chat('system', '⏹ Orchestration stopped by user.');
    this.eventBus.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        error: 'Stopped by user',
        phase: this.phaseEngine.getCurrentPhase(),
        recoverable: true,
      },
    });
    this.emitStateUpdate();
  }

  requestPause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    this.chat('system', '⏸ Orchestration paused by user. Use "Continue" to resume.');
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: this.phaseEngine.getCurrentPhase(),
        thought: 'Orchestration paused by user',
        timestamp: Date.now(),
      },
    });
    this.emitStateUpdate();
  }

  requestResume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.chat('system', '▶️ Orchestration resumed by user.');
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: this.phaseEngine.getCurrentPhase(),
        thought: 'Orchestration resumed by user',
        timestamp: Date.now(),
      },
    });
    this.emitStateUpdate();
  }

  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * Emit a consolidated state snapshot so the UI can initialize and re-sync
   * without depending solely on the granular event stream. The
   * OMNIFLOW_STATE_UPDATE contract was defined (shared/types) but never
   * emitted, leaving the UI on default state until the first granular event
   * arrived. We emit this at lifecycle boundaries so a freshly-attached
   * webview immediately sees the real phase/agents/running state.
   */
  private emitStateUpdate(): void {
    this.eventBus.emit({
      type: 'OMNIFLOW_STATE_UPDATE',
      payload: {
        currentPhase: this.phaseEngine.getCurrentPhase(),
        completedPhases: this.phaseEngine.getCompletedPhases(),
        agents: Object.fromEntries(this.agentStatuses) as Record<string, AgentStatus>,
        artifacts: [],
        isRunning: this.isRunning,
      },
    });
  }

  private assertNotCancelled(): void {
    if (this.cancelRequested) throw new Error('Orchestration cancelled by user');
  }

  /** Block the pipeline while the user has paused it; resolves immediately otherwise. */
  private async waitWhilePaused(): Promise<void> {
    while (this.isPaused && !this.cancelRequested) {
      await new Promise((r) => setTimeout(r, 300));
    }
    this.assertNotCancelled();
  }

  exportSessionSnapshot(): Record<string, unknown> {
    return {
      phase: this.phaseEngine.getCurrentPhase(),
      completedPhases: this.phaseEngine.getCompletedPhases(),
      agentStatuses: Object.fromEntries(this.agentStatuses),
      ledgerPath: this.ledger.getLedgerPath(),
      spawnedAgents: Array.from(this.spawnedAgents),
      edges: this.runtimeEdges,
      exportedAt: new Date().toISOString(),
    };
  }

  private chat(role: 'user' | 'assistant' | 'system', content: string): void {
    this.eventBus.emit({ type: 'CHAT_MESSAGE', payload: { role, content, timestamp: Date.now() } });
  }

  private emitArtifact(taskId: string, filePath: string, agentId: string): void {
    this.eventBus.emit({ type: 'ARTIFACT_CREATED', payload: { filePath, agentId, taskId } });
    this.ledger.append({ type: 'artifact_created', data: { filePath, agentId, taskId } });
  }

  private async runPhaseSafely<T>(fn: () => Promise<T>, label: string, maxRetries = 2): Promise<T> {
    this.assertNotCancelled();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/reject|approval|user/i.test(msg)) throw err; // never retry user decisions
        if (attempt < maxRetries) {
          this.chat('system', `⚠ ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg}. Retrying...`);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    this.eventBus.emit({ type: 'ERROR_OCCURRED', payload: { error: `${label} failed after ${maxRetries + 1} attempts: ${msg}`, phase: this.phaseEngine.getCurrentPhase(), recoverable: false } });
    throw lastErr instanceof Error ? lastErr : new Error(msg);
  }

  getCurrentState() {
    return {
      currentPhase: this.phaseEngine.getCurrentPhase(),
      completedPhases: this.phaseEngine.getCompletedPhases(),
      isRunning: this.isRunning,
    };
  }

  isCurrentlyRunning(): boolean {
    return this.isRunning;
  }

  setSupervisorMode(enabled: boolean): void {
    this.useSupervisor = enabled;
    this.supervisor.setUseSupervisor(enabled);
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: 'build',
        thought: `Supervisor mode ${enabled ? 'enabled' : 'disabled'}`,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Walk the workspace root into a bounded tree and emit it to the webview as a
   * WORKSPACE_TREE event. Depth is capped (default 3) and the total number of
   * emitted entries is capped (default 300) so a huge workspace can't flood the
   * UI. Generated/build/deps directories are skipped.
   */
  requestWorkspaceTree(maxDepth = 3, maxEntries = 300): void {
    try {
      const root = this.workspaceRoot;
      const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'generated']);
      let count = 0;

      const walk = (dir: string, depth: number): any[] => {
        if (depth > maxDepth || count >= maxEntries) return [];
        let entries: import('fs').Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: any[] = [];
        for (const e of entries) {
          if (count >= maxEntries) break;
          if (SKIP.has(e.name)) continue;
          if (e.name.startsWith('.')) continue;
          const abs = path.join(dir, e.name);
          const isDir = e.isDirectory();
          count++;
          const node: any = {
            name: e.name,
            path: abs,
            type: isDir ? 'directory' : 'file',
          };
          if (isDir) node.children = walk(abs, depth + 1);
          nodes.push(node);
        }
        return nodes;
      };

      const tree = walk(root, 0);
      this.eventBus.emit({
        type: 'WORKSPACE_TREE',
        payload: { root, tree },
      });
    } catch (err) {
      this.chat('system', 'Workspace tree failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}
