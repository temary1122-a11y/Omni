import type { HandoffContract, ArtifactManifest, FileArtifact, AgentReasoning, Phase, AgentRole, AgentCommentary, ToolCallEvent, ToolResultEvent, Complexity } from '../../shared/types';
import * as crypto from 'crypto';
import { EventBus } from '../core/EventBus';

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
    const candidates = [content, reasoning].filter(Boolean) as string[];
    
    for (const text of candidates) {
      if (!text) continue;

      // Prefer the whole text as JSON (after stripping markdown fences). This keeps
      // enclosing objects intact when the payload contains nested arrays.
      const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
      try {
        JSON.parse(stripped);
        return stripped;
      } catch {
        // Continue to more lenient patterns below
      }

      // Try to extract JSON from markdown code blocks
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        const extracted = codeBlockMatch[1].trim();
        try {
          JSON.parse(extracted);
          return extracted;
        } catch {
          // Continue to other patterns
        }
      }

      // Try to find array pattern directly in content
      const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrayMatch) {
        try {
          JSON.parse(arrayMatch[0]);
          return arrayMatch[0].trim();
        } catch {
          // Continue to other patterns
        }
      }

      // Try to find JSON object with common properties
      const propertyPatterns = [
        /"questions"\s*:\s*(\[[\s\S]*?\])/,
        /"subtasks"\s*:\s*(\[[\s\S]*?\])/,
        /"terms"\s*:\s*(\[[\s\S]*?\])/,
        /"bestPractices"\s*:\s*(\[[\s\S]*?\])/,
        /"patterns"\s*:\s*(\[[\s\S]*?\])/,
      ];

      for (const pattern of propertyPatterns) {
        const match = text.match(pattern);
        if (match) {
          try {
            JSON.parse(match[1]);
            return match[1].trim();
          } catch {
            // Continue to next pattern
          }
        }
      }

      // Try to parse the entire text as JSON
      try {
        JSON.parse(text);
        return text;
      } catch {
        // Continue to next candidate
      }
    }

    return content || '';
  }

  /**
   * Best-effort structured LLM call used by advisory agents (audit/security).
   * Never throws: on any error or provider fallback it reports the degradation and
   * returns null so the caller can continue with heuristic-only behavior.
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
      if (res.usedFallback) {
        this.emitCommentary(request.phase, `LLM review unavailable: ${res.error || 'provider fallback'}`);
        return null;
      }
      const raw = this.extractJsonFromLLMResponse(res.content, res.reasoning);
      if (!raw) {
        this.emitCommentary(request.phase, 'LLM review returned no parseable response');
        return null;
      }
      const parsed = JSON.parse(raw);
      return { raw, parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitCommentary(request.phase, `LLM review failed: ${message}`);
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
