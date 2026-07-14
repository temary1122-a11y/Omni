/**
 * PromptOrchestrator
 * 
 * Manages self-prompting loops between agents
 * Agents can prompt each other dynamically based on context
 */

import { EventBus } from './EventBus';
import type { Phase } from '../../shared/types';

export interface AgentMessage {
  from: string;
  to: string;
  prompt: string;
  response: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SelfPromptingAgent {
  agentId: string;
  generatePromptFor(goal: string, targetAgent: string, context: AgentMessage[]): Promise<string>;
  respondToPrompt(prompt: string, context: AgentMessage[]): Promise<AgentResponse>;
  evaluateConversation(history: AgentMessage[]): Promise<number>;
}

export interface SelfPromptingLoopResult {
  finalGoal: string;
  conversationHistory: AgentMessage[];
  converged: boolean;
  rounds: number;
  stopReason: 'converged' | 'needs_more_info' | 'max_rounds';
}

export interface AgentResponse {
  content: string;
  confidence: number;
  needsMoreInfo: boolean;
  suggestedNextAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptOrchestratorOptions {
  maxRounds: number;
  convergenceThreshold: number;
  eventBus: EventBus;
}

export class PromptOrchestrator {
  private agents: Map<string, SelfPromptingAgent> = new Map();
  private conversationHistory: AgentMessage[] = [];
  private options: PromptOrchestratorOptions;

  constructor(options: PromptOrchestratorOptions) {
    this.options = options;
  }

  /**
   * Register an agent for self-prompting
   */
  registerAgent(agent: SelfPromptingAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Get the next agent in the conversation flow
   */
  private getNextAgent(currentAgentId: string): string | null {
    const agentIds = Array.from(this.agents.keys());
    const currentIndex = agentIds.indexOf(currentAgentId);
    
    if (currentIndex === -1) return null;
    
    const nextIndex = (currentIndex + 1) % agentIds.length;
    return agentIds[nextIndex];
  }

  /**
   * Synthesize new goal from conversation history
   */
  private synthesizeNewGoal(initialGoal: string, recentMessages: AgentMessage[]): string {
    if (recentMessages.length === 0) return initialGoal;

    const lastResponse = recentMessages[recentMessages.length - 1].response;
    const keyInsights = this.extractKeyInsights(recentMessages);

    return `${initialGoal}\n\nRefined based on agent collaboration:\n${keyInsights}`;
  }

  /**
   * Extract key insights from conversation history
   */
  private extractKeyInsights(messages: AgentMessage[]): string {
    return messages
      .slice(-3) // Last 3 messages
      .map(m => `- ${m.to}: ${m.response.slice(0, 200)}`)
      .join('\n');
  }

  /**
   * Check if conversation has converged
   */
  private isConverged(history: AgentMessage[]): boolean {
    if (history.length < 3) return false;

    const recentScores = history.slice(-3).map(m => 
      m.metadata?.confidence as number || 0
    );

    const avgConfidence = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
    return avgConfidence >= this.options.convergenceThreshold;
  }

  /**
   * Run self-prompting loop
   */
  async runSelfPromptingLoop(
    initialGoal: string,
    startAgentId?: string
  ): Promise<SelfPromptingLoopResult> {
    let currentGoal = initialGoal;
    let currentAgentId = startAgentId || Array.from(this.agents.keys())[0];
    
    if (!currentAgentId) {
      throw new Error('No agents registered');
    }

    this.options.eventBus.emit({
      type: 'REASONING_TRACE',
      payload: {
        agentId: 'orchestrator',
        phase: 'self-prompting' as Phase,
        thought: `Starting self-prompting loop with ${this.agents.size} agents`,
        timestamp: Date.now(),
      } as any,
    });

    for (let round = 0; round < this.options.maxRounds; round++) {
      const roundMessages: AgentMessage[] = [];
      const agentIds = Array.from(this.agents.keys());
      const startIndex = Math.max(0, agentIds.indexOf(currentAgentId));
      const orderedAgents =
        startIndex === 0 ? agentIds : [...agentIds.slice(startIndex), ...agentIds.slice(0, startIndex)];

      // Each agent prompts the next one
      for (const agentId of orderedAgents) {
        const nextAgentId = this.getNextAgent(agentId);
        if (!nextAgentId) continue;

        const agent = this.agents.get(agentId);
        const nextAgent = this.agents.get(nextAgentId);
        
        if (!agent || !nextAgent) continue;

        try {
          // Generate prompt
          const prompt = await agent.generatePromptFor(
            currentGoal,
            nextAgentId,
            this.conversationHistory
          );

          // Get response
          const response = await nextAgent.respondToPrompt(
            prompt,
            this.conversationHistory
          );
          const conversationConfidence = await nextAgent.evaluateConversation(this.conversationHistory);
          const effectiveConfidence = Math.min(response.confidence, conversationConfidence);

          const message: AgentMessage = {
            from: agentId,
            to: nextAgentId,
            prompt,
            response: response.content,
            timestamp: Date.now(),
            metadata: {
              confidence: effectiveConfidence,
              needsMoreInfo: response.needsMoreInfo,
              conversationConfidence,
            },
          };

          this.conversationHistory.push(message);
          roundMessages.push(message);

          this.options.eventBus.emit({
            type: 'AGENT_COMMENTARY',
            payload: {
              agentId: 'orchestrator',
              phase: 'self-prompting' as Phase as Phase,
              message: `${agentId} → ${nextAgentId}: ${prompt.slice(0, 100)}...`,
              timestamp: Date.now(),
            } as any,
          });

          // Check if agent suggests a different next agent
          if (response.suggestedNextAgent && this.agents.has(response.suggestedNextAgent)) {
            currentAgentId = response.suggestedNextAgent;
          }

          // If response indicates more info needed, break and let user provide
          const clarificationThreshold = Math.min(0.65, this.options.convergenceThreshold * 0.8);
          if (response.needsMoreInfo || effectiveConfidence < clarificationThreshold) {
            this.options.eventBus.emit({
              type: 'ERROR_OCCURRED',
              payload: {
                error: response.needsMoreInfo
                  ? 'Agent needs more information from user'
                  : `Conversation confidence too low (${effectiveConfidence.toFixed(2)})`,
                phase: 'self-prompting' as Phase as Phase,
                recoverable: true,
              } as any,
            });

            return {
              finalGoal: currentGoal,
              conversationHistory: this.conversationHistory,
              converged: false,
              rounds: round + 1,
              stopReason: 'needs_more_info',
            };
          }
        } catch (error) {
          this.options.eventBus.emit({
            type: 'ERROR_OCCURRED',
            payload: {
              error: `Self-prompting failed: ${error}`,
              phase: 'self-prompting' as Phase as Phase,
              recoverable: true,
            } as any,
          });
        }
      }

      // Synthesize new goal from round
      currentGoal = this.synthesizeNewGoal(initialGoal, roundMessages);

      // Check convergence
      if (this.isConverged(this.conversationHistory)) {
        this.options.eventBus.emit({
          type: 'REASONING_TRACE',
          payload: {
            agentId: 'orchestrator',
            phase: 'self-prompting' as Phase,
            thought: `Conversation converged after ${round + 1} rounds`,
            timestamp: Date.now(),
          },
        });

        return {
          finalGoal: currentGoal,
          conversationHistory: this.conversationHistory,
          converged: true,
          rounds: round + 1,
          stopReason: 'converged',
        };
      }
    }

    // Max rounds reached without convergence
    return {
      finalGoal: currentGoal,
      conversationHistory: this.conversationHistory,
      converged: false,
      rounds: this.options.maxRounds,
      stopReason: 'max_rounds',
    };
  }

  /**
   * Get conversation history
   */
  getHistory(): AgentMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get registered agents
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.agents.keys());
  }
}
