import type { Phase, AgentRole, AgentStatus, HandoffContract, ContextPacket, ArtifactManifest, Complexity } from '../../shared/types';
import { EventBus } from './EventBus';
import { PhaseEngine } from './PhaseEngine';
import { OrchestrationPolicy, OrchestrationState, OrchestrationAction } from './OrchestrationPolicy';
import { sleep, backoffDelayMs } from '../util/async';

export interface AgentState {
  agentId: string;
  role: AgentRole;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface SupervisorDecision {
  action: 'spawn' | 'wait' | 'escalate' | 'fallback' | 'complete';
  targetAgent?: AgentRole;
  reason: string;
  parallelism?: boolean;
}

export interface TaskDependency {
  subtaskId: string;
  dependsOn: string[];
  canRunInParallel: boolean;
}

export interface ExecutorMap {
  [key: string]: {
    execute: (contract: HandoffContract, workspaceRoot: string) => Promise<ArtifactManifest>;
  };
}

export interface AgentSupervisorOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export class AgentSupervisor {
  private agentStates = new Map<AgentRole, AgentState>();
  private policy = new OrchestrationPolicy();
  private readonly defaults: Required<AgentSupervisorOptions> = {
    timeoutMs: 60000,
    maxRetries: 3,
    retryBaseDelayMs: 1000,
  };

  constructor(
    private eventBus: EventBus,
    private phaseEngine: PhaseEngine,
    private options: AgentSupervisorOptions = {}
  ) {
    this.options = { ...this.defaults, ...options };
    this.initializeAgentStates();
    this.setupDefaultPolicy();
  }

  private initializeAgentStates(): void {
    const roles: AgentRole[] = ['orchestrator', 'clarifier', 'researcher', 'planner', 'coder', 'auditor', 'security', 'verifier'];
    for (const role of roles) {
      this.agentStates.set(role, { agentId: role, role, status: 'idle' });
    }
  }

  private setupDefaultPolicy(): void {
    this.policy.addRule({
      id: 'parallel-independent-tasks',
      priority: 100,
      condition: (s) => s.pendingContracts.length > 1 && s.pendingContracts.every((c) => !c.dependsOn?.length),
      actionFactory: () => ({ type: 'parallel' }),
    });

    this.policy.addRule({
      id: 'sequential-dependent-tasks',
      priority: 90,
      condition: (s) => s.pendingContracts.length > 0 && s.pendingContracts.some((c) => c.dependsOn?.length),
      actionFactory: () => ({ type: 'sequential' }),
    });

    this.policy.addRule({
      id: 'single-task-default',
      priority: 70,
      condition: (s) => s.pendingContracts.length > 0,
      actionFactory: () => ({ type: 'sequential' }),
    });

    this.policy.addRule({
      id: 'retry-failed-agent',
      priority: 80,
      condition: (s) => s.failedAgents.length > 0,
      actionFactory: () => ({ type: 'retry' }),
    });
  }

  async orchestrate(
    contracts: HandoffContract[],
    context: ContextPacket,
    executors: ExecutorMap,
    workspaceRoot: string,
    complexity: Complexity = 'medium'
  ): Promise<ArtifactManifest[]> {
    this.updateAgentStatus('orchestrator', 'working');

    const state: OrchestrationState = {
      currentPhase: this.phaseEngine.getCurrentPhase(),
      completedAgents: [],
      failedAgents: [],
      pendingContracts: contracts,
      resourceBudget: { tokens: 0, models: [] },
      taskComplexity: complexity,
    };

    const actions = this.policy.evaluate(state);

    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: 'build',
        thought: `Supervisor evaluating ${contracts.length} contracts, actions: ${actions.map((a) => a.type).join(', ')}`,
        timestamp: Date.now(),
      },
    });

    const manifests: ArtifactManifest[] = [];

    for (const action of actions) {
      const batch = this.getExecutableContracts(contracts, action);
      if (action.type === 'parallel') {
        const batchManifests = await this.executeParallel(batch, executors, workspaceRoot);
        manifests.push(...batchManifests);
      } else if (action.type === 'sequential') {
        const batchManifests = await this.executeSequential(batch, executors, workspaceRoot);
        manifests.push(...batchManifests);
      }
    }

    this.updateAgentStatus('orchestrator', 'done');
    return manifests;
  }

  analyzeTasks(contracts: HandoffContract[]): TaskDependency[] {
    const allIds = new Set(contracts.map((c) => c.subtaskId));
    const resolved: TaskDependency[] = [];

    for (const contract of contracts) {
      const dependsOn = contract.dependsOn ?? [];
      const validDeps = dependsOn.filter((d) => allIds.has(d));
      const canRunInParallel = validDeps.length === 0;

      resolved.push({
        subtaskId: contract.subtaskId,
        dependsOn: validDeps,
        canRunInParallel,
      });
    }

    return resolved;
  }

  getSystemState(): Record<AgentRole, AgentStatus> {
    const result: Record<string, AgentStatus> = {};
    this.agentStates.forEach((state, role) => {
      result[role] = state.status;
    });
    return result;
  }

  handleAgentFailure(agentId: AgentRole, error: Error): void {
    const state = this.agentStates.get(agentId);
    if (state) {
      state.status = 'error';
      state.error = error.message;
      this.agentStates.set(agentId, state);
    }

    this.eventBus.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        error: error.message,
        phase: this.phaseEngine.getCurrentPhase(),
        recoverable: true,
      },
    });

    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: this.phaseEngine.getCurrentPhase(),
        thought: `Agent ${agentId} failed: ${error.message}. Attempting recovery.`,
        timestamp: Date.now(),
      },
    });
  }

  setUseSupervisor(enabled: boolean): void {
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

  private updateAgentStatus(role: AgentRole, status: AgentStatus, message?: string): void {
    const currentState = this.agentStates.get(role) ?? { agentId: role, role, status: 'idle' };
    const newState: AgentState = {
      ...currentState,
      status,
      startTime: status === 'working' ? Date.now() : currentState.startTime,
      endTime: status === 'done' || status === 'error' ? Date.now() : currentState.endTime,
      error: status === 'error' ? message : undefined,
    };
    this.agentStates.set(role, newState);

    this.eventBus.emit({
      type: 'AGENT_STATUS_UPDATE',
      payload: { agentId: role, status, message },
    });
  }

  private getExecutableContracts(contracts: HandoffContract[], action: OrchestrationAction): HandoffContract[] {
    if (action.type === 'parallel') {
      return contracts;
    }
    if (action.type === 'sequential') {
      return contracts;
    }
    return contracts;
  }

  private async executeParallel(
    contracts: HandoffContract[],
    executors: ExecutorMap,
    workspaceRoot: string
  ): Promise<ArtifactManifest[]> {
    const results = await Promise.allSettled(
      contracts.map((contract) => this.executeWithRetry(contract, executors, workspaceRoot))
    );

    const manifests: ArtifactManifest[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const contract = contracts[i];

      if (result.status === 'fulfilled') {
        manifests.push(result.value);
        this.updateAgentStatus(contract.agentRole, 'done');
      } else {
        this.handleAgentFailure(contract.agentRole, result.reason);
        const fallbackManifest = await this.executeFallback(contract, executors, workspaceRoot);
        if (fallbackManifest) {
          manifests.push(fallbackManifest);
        }
      }
    }

    return manifests;
  }

  private async executeSequential(
    contracts: HandoffContract[],
    executors: ExecutorMap,
    workspaceRoot: string
  ): Promise<ArtifactManifest[]> {
    const manifests: ArtifactManifest[] = [];

    for (const contract of contracts) {
      try {
        this.updateAgentStatus(contract.agentRole, 'working');
        const manifest = await this.executeWithRetry(contract, executors, workspaceRoot);
        manifests.push(manifest);
        this.updateAgentStatus(contract.agentRole, 'done');
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.handleAgentFailure(contract.agentRole, err);
        const fallbackManifest = await this.executeFallback(contract, executors, workspaceRoot);
        if (fallbackManifest) {
          manifests.push(fallbackManifest);
        }
      }
    }

    return manifests;
  }

  private async executeWithRetry(
    contract: HandoffContract,
    executors: ExecutorMap,
    workspaceRoot: string
  ): Promise<ArtifactManifest> {
    const executor = executors[contract.agentRole];
    if (!executor) {
      throw new Error(`No executor for agent role: ${contract.agentRole}`);
    }

    let lastError: Error | null = null;
    const maxRetries = this.options.maxRetries ?? this.defaults.maxRetries;
    const timeoutMs = this.options.timeoutMs ?? this.defaults.timeoutMs;
    const retryBaseDelayMs = this.options.retryBaseDelayMs ?? this.defaults.retryBaseDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const manifest = await this.withTimeout(
          executor.execute(contract, workspaceRoot),
          timeoutMs
        );
        return manifest;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await sleep(backoffDelayMs(attempt, { baseMs: retryBaseDelayMs }));
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
  }

  private async executeFallback(
    contract: HandoffContract,
    executors: ExecutorMap,
    workspaceRoot: string
  ): Promise<ArtifactManifest | null> {
    const legacyExecutor = executors['coder'];
    if (!legacyExecutor || contract.agentRole === 'coder') {
      return null;
    }

    try {
      const fallbackContract: HandoffContract = {
        ...contract,
        agentRole: 'coder',
      };
      return await legacyExecutor.execute(fallbackContract, workspaceRoot);
    } catch (error) {
      return null;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

}