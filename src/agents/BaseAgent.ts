import type { HandoffContract, ArtifactManifest, FileArtifact, AgentReasoning, Phase, AgentRole, AgentCommentary, ToolCallEvent, ToolResultEvent, Complexity } from '../../shared/types';
import * as crypto from 'crypto';
import { EventBus } from '../core/EventBus';
import { extractJsonFromLLMResponse } from '../util/llmJson';

/**
 * Minimal structural type for any model router the agents can call. Duck-typed
 * so BaseAgent does not take a hard dependency on a concrete router class.
 */
export interface LlmReviewRouter {
  call(
    request: { phase: Phase; agentRole: AgentRole; complexity: Complexity },
    prompt: string,
    systemPrompt: string,
    apiKeys: Record<string, string>,
    forceProvider?: string,
    tools?: unknown[]
  ): Promise<{ content: string; reasoning?: string; usedFallback?: boolean; error?: string }>;
}

export interface LlmReviewResult {
  /** Raw JSON string extracted from the model response. */
  raw: string;
  /** Parsed JSON object, or null if the body was not valid JSON. */
  parsed: unknown;
}

export abstract class BaseAgent {
  protected agentId: string;
  protected eventBus?: EventBus;
  protected currentPhase: Phase = 'build';

  constructor(agentId: string, eventBus?: EventBus) {
    this.agentId = agentId;
    this.eventBus = eventBus;
  }

  abstract execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest>;

  protected validateContract(contract: HandoffContract): boolean {
    return !!(
      contract.subtaskId &&
      contract.agentRole &&
      contract.contextPacket &&
      contract.successCriteria.length > 0
    );
  }

  protected createManifest(
    subtaskId: string,
    artifacts: FileArtifact[],
    selfVerification: string
  ): ArtifactManifest {
    return { artifacts, subtaskId, completedAt: Date.now(), selfVerification };
  }

  protected hash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  protected extractJsonFromLLMResponse(content: string | undefined, reasoning: string | undefined): string {
    return extractJsonFromLLMResponse(content, reasoning);
  }

  /**
   * Best-effort structured LLM call used by advisory agents (audit/security).
   * Never throws: on any error or provider fallback it returns null so the caller
   * can silently degrade to heuristic-only behavior. This keeps the audit/security
   * phase from dying when the network, budget, or model is unavailable.
   */
  protected async callLlmJsonReview(
    router: LlmReviewRouter | undefined,
    apiKeys: Record<string, string> | undefined,
    request: { phase: Phase; agentRole: AgentRole; complexity: Complexity },
    prompt: string,
    systemPrompt: string
  ): Promise<LlmReviewResult | null> {
    if (!router || !apiKeys) return null;
    try {
      const res = await router.call(request, prompt, systemPrompt, apiKeys);
      if (res.usedFallback) return null;
      const raw = this.extractJsonFromLLMResponse(res.content, res.reasoning);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return { raw, parsed };
    } catch {
      return null;
    }
  }

  protected emitReasoning(phase: Phase, thought: string): void {
    if (!this.eventBus) return;
    this.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: this.agentId as AgentRole,
        phase,
        thought,
        timestamp: Date.now(),
      } as AgentReasoning,
    });
  }

  protected emitCommentary(phase: Phase, message: string): void {
    if (!this.eventBus) return;
    this.eventBus.emit({
      type: 'AGENT_COMMENTARY',
      payload: {
        agentId: this.agentId as AgentRole,
        phase,
        message,
        timestamp: Date.now(),
      } as AgentCommentary,
    });
  }

  protected emitToolCall(phase: Phase, toolName: string, args?: Record<string, unknown>): void {
    if (!this.eventBus) return;
    this.eventBus.emit({
      type: 'TOOL_CALL',
      payload: {
        agentId: this.agentId as AgentRole,
        toolName,
        args,
        timestamp: Date.now(),
      } as ToolCallEvent,
    });
  }
  protected emitToolResult(phase: Phase, toolName: string, success: boolean, output?: string, error?: string): void {
    if (!this.eventBus) return;
    this.eventBus.emit({
      type: 'TOOL_RESULT',
      payload: {
        agentId: this.agentId as AgentRole,
        phase,
        toolName,
        success,
        output,
        error,
        timestamp: Date.now(),
      } as ToolResultEvent,
    });
  }
}
