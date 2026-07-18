/**
 * SelfLearningEngine — Continuous improvement through pattern recognition.
 *
 * THE PROBLEM:
 * OmniFlow starts fresh every session. No matter how many times the coder
 * successfully uses "read → test → write → test → verify" pattern, it never
 * internalizes it. No matter how often the researcher finds Wikipedia summaries
 * better than random search results, it never learns to prefer them.
 *
 * THE SOLUTION:
 * SelfLearningEngine observes the ReAct loop in real-time, extracts
 * successful patterns, and turns them into reusable LearnedStrategies.
 * Over time, OmniFlow gets smarter — it develops "intuition" about what
 * works and what doesn't for specific task types.
 *
 * THREE TIERS OF LEARNING:
 *
 * 1. Pattern Recognition (fast, in-session)
 *    - Detects repeating successful tool sequences
 *    - Suggests the learned sequence when the same task type appears
 *    - Example: "For Python scripts, always: write_file → npm test → read_file verify"
 *
 * 2. Strategy Optimization (across sessions)
 *    - Tracks which prompt strategies produce the best results
 *    - Associates strategies with task types and complexity tiers
 *    - Persisted to disk in .omniflow/learned-strategies.json
 *
 * 3. Failure Pattern Learning (defensive)
 *    - Remembers patterns that led to failures
 *    - Actively warns agents before they repeat known failure paths
 *    - Example: "Don't try Docker on Windows without WSL2"
 *
 * DATA STRUCTURE:
 * Each LearnedStrategy is a typed object with:
 *   - trigger: when to apply (task type, keyword, complexity)
 *   - sequence: ordered tool calls / prompt fragments
 *   - successRate: how often it works
 *   - domains: which agent roles it applies to
 *   - version: auto-incremented when refined
 *
 * PRIVACY:
 * All learning data stays LOCAL — .omniflow/ directory in workspace.
 * Nothing is sent to any server. OmniFlow learns from YOUR work, for YOUR work.
 *
 * INTEGRATION:
 *   OmniOrchestrator → SelfLearningEngine
 *                      ├─ observed by AgentRuntime (every tool call)
 *                      ├─ queried before build phase (suggests strategies)
 *                      └─ queried by TaskCompass (failure prevention)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────

export type StrategyDomain = 'planning' | 'building' | 'testing' | 'research' | 'debugging' | 'refactoring' | 'deployment';
export type AgentRoleId = 'clarifier' | 'researcher' | 'planner' | 'coder' | 'auditor' | 'security' | 'verifier';

export interface ObservedAction {
  agentId: AgentRoleId;
  toolName: string;
  toolArgs: Record<string, any>;
  success: boolean;
  durationMs: number;
  timestamp: number;
  /** What the agent was trying to accomplish in this step. */
  intent?: string;
}

export interface ActionSequence {
  actions: ObservedAction[];
  /** Whether the entire sequence succeeded. */
  overallSuccess: boolean;
  /** Total wall-clock time. */
  totalDurationMs: number;
  /** Task ID this belongs to. */
  taskId: string;
  /** Human-readable label for what was accomplished. */
  outcome: string;
}

export interface LearnedStrategy {
  id: string;
  /** Human-readable name. */
  name: string;
  /** When to suggest this strategy. */
  trigger: {
    taskKeywords: string[];
    complexity?: ('LOW' | 'MEDIUM' | 'HIGH')[];
    domains: StrategyDomain[];
    agentRoles: AgentRoleId[];
    languagePatterns?: string[];
  };
  /** The actual strategy content. */
  strategy: {
    /** Ordered tool sequence template. */
    toolSequence: Array<{
      toolName: string;
      description: string;
      criticalArgs?: Record<string, string>;
    }>;
    /** Prompt fragments that worked well. */
    promptHints: string[];
    /** Pre-conditions (what must be true before applying). */
    preconditions: string[];
    /** Expected outcomes. */
    expectedOutcomes: string[];
  };
  /** Performance tracking. */
  stats: {
    successRate: number;
    usageCount: number;
    totalTimeSavedMs: number;
    lastUsed: number;
    createdAt: number;
  };
  /** Auto-extracted from observations */
  confidenceScore: number;
  /** Version (incremented on refinement) */
  version: number;
}

export interface FailurePattern {
  id: string;
  /** What failed. */
  failure: {
    toolName: string;
    errorPattern: string;
    context: string;
    domain: StrategyDomain;
  };
  /** Suggested avoidance. */
  prevention: {
    alternative: string;
    checkBefore: string;
    warningMessage: string;
  };
  /** How many times we've seen this. */
  occurrences: number;
  lastSeen: number;
}

export interface LearningSession {
  sessionId: string;
  startedAt: number;
  taskCount: number;
  sequences: ActionSequence[];
  rawObservations: ObservedAction[];
}

export interface SelfLearningConfig {
  /** Minimum sequence length to consider for pattern extraction. Default: 3. */
  minSequenceLength: number;
  /** Minimum success rate to promote to LearnedStrategy. Default: 0.7. */
  promotionThreshold: number;
  /** Minimum usage count before strategy is considered "mature". Default: 5. */
  maturityThreshold: number;
  /** How many strategies to keep per domain. Default: 10. */
  maxStrategiesPerDomain: number;
  /** Max observations kept in-memory before compression. Default: 500. */
  maxObservationsInMemory: number;
  /** Auto-flush to disk interval in ms. Default: 60000. */
  flushIntervalMs: number;
}

const DEFAULT_CONFIG: SelfLearningConfig = {
  minSequenceLength: 3,
  promotionThreshold: 0.7,
  maturityThreshold: 5,
  maxStrategiesPerDomain: 10,
  maxObservationsInMemory: 500,
  flushIntervalMs: 60000,
};

// ─── Engine ──────────────────────────────────────────────────────────────

export class SelfLearningEngine {
  private config: SelfLearningConfig;
  private strategies: Map<string, LearnedStrategy> = new Map();
  private failurePatterns: Map<string, FailurePattern> = new Map();
  private currentSession: LearningSession;
  private workspaceRoot: string;
  private storagePath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(workspaceRoot: string, config?: Partial<SelfLearningConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workspaceRoot = workspaceRoot;
    this.storagePath = path.join(workspaceRoot, '.omniflow', 'learned-strategies.json');
    this.currentSession = this.createSession();

    this.loadFromDisk();
    this.startAutoFlush();
  }

  // ─── Observation API ──────────────────────────────────────────────────

  /** Record a single tool action (called from AgentRuntime after every tool call). */
  observe(action: ObservedAction): void {
    this.currentSession.rawObservations.push(action);

    if (this.currentSession.rawObservations.length > this.config.maxObservationsInMemory) {
      this.analyzeCurrentSequences();
    }
  }

  /** Record a complete action sequence (called when a build/test phase completes). */
  recordSequence(sequence: ActionSequence): void {
    this.currentSession.sequences.push(sequence);

    if (sequence.overallSuccess) {
      this.tryExtractStrategy(sequence);
    } else {
      this.tryExtractFailure(sequence);
    }
  }

  // ─── Query API ────────────────────────────────────────────────────────

  /**
   * Get suggested strategies for a task.
   * Called before the build phase to give the coder proven approaches.
   */
  suggestStrategies(
    goal: string,
    complexity: 'LOW' | 'MEDIUM' | 'HIGH',
    agentRole: AgentRoleId
  ): LearnedStrategy[] {
    const g = goal.toLowerCase();
    const keywords = this.extractKeywords(g);
    const candidates: { strategy: LearnedStrategy; score: number }[] = [];

    for (const [, strategy] of this.strategies) {
      if (!strategy.trigger.agentRoles.includes(agentRole)) continue;
      if (strategy.trigger.complexity && !strategy.trigger.complexity.includes(complexity)) continue;
      if (strategy.stats.successRate < 0.5) continue;

      let score = strategy.stats.successRate * strategy.confidenceScore;

      // Boost: keyword match
      const matchedKeywords = strategy.trigger.taskKeywords.filter(
        kw => keywords.includes(kw.toLowerCase())
      );
      score += matchedKeywords.length * 0.1;

      // Boost: recently used and successful
      if (strategy.stats.lastUsed > Date.now() - 3600_000) score += 0.15; // last hour
      if (strategy.stats.usageCount > this.config.maturityThreshold) score += 0.1;

      if (score > 0.5) {
        candidates.push({ strategy, score });
      }
    }

    // Sort by score, deduplicate
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(c => c.strategy);
  }

  /**
   * Check if current action resembles a known failure pattern.
   * Returns a warning message if the agent is about to repeat a failure.
   */
  checkFailureRisk(
    toolName: string,
    toolArgs: Record<string, any>,
    agentId: string
  ): string | null {
    const actionKey = `${agentId}:${toolName}`;
    const context = JSON.stringify(toolArgs).toLowerCase();

    for (const [, pattern] of this.failurePatterns) {
      if (pattern.failure.toolName === actionKey &&
          pattern.occurrences >= 3 &&
          context.includes(pattern.failure.errorPattern.toLowerCase())) {
        return pattern.prevention.warningMessage;
      }
    }

    return null;
  }

  // ─── Analysis ─────────────────────────────────────────────────────────

  private tryExtractStrategy(sequence: ActionSequence): void {
    const actions = sequence.actions;
    if (actions.length < this.config.minSequenceLength) return;

    // Extract the tool sequence
    const toolSequence = actions.map(a => ({
      toolName: a.toolName,
      description: a.intent || `Call ${a.toolName}`,
    }));

    // Calculate success rate from observations
    const successCount = actions.filter(a => a.success).length;
    const successRate = successCount / actions.length;

    if (successRate < this.config.promotionThreshold) return;

    // Determine domain from agent roles and tool usage
    const domain = this.inferDomain(actions);

    // Generate strategy ID
    const name = this.generateStrategyName(actions, domain);
    const id = 'strategy_' + crypto.createHash('md5').update(name).digest('hex').slice(0, 12);

    // Check for existing similar strategy (update instead of duplicate)
    const existing = this.findSimilarStrategy(toolSequence, domain);
    if (existing) {
      existing.stats.successRate = (existing.stats.successRate * existing.stats.usageCount + successRate) / (existing.stats.usageCount + 1);
      existing.stats.usageCount++;
      existing.stats.lastUsed = Date.now();
      existing.stats.totalTimeSavedMs += sequence.totalDurationMs * 0.3; // estimate 30% time save
      existing.confidenceScore = Math.min(1.0, existing.confidenceScore + 0.02);
      existing.version++;
      return;
    }

    // Create new strategy
    const strategy: LearnedStrategy = {
      id,
      name,
      trigger: {
        taskKeywords: this.extractKeywords(sequence.outcome),
        complexity: ['LOW', 'MEDIUM', 'HIGH'],
        domains: [domain],
        agentRoles: this.extractAgentRoles(actions),
      },
      strategy: {
        toolSequence: toolSequence.slice(0, 10),
        promptHints: this.extractPromptHints(actions),
        preconditions: [],
        expectedOutcomes: [sequence.outcome],
      },
      stats: {
        successRate,
        usageCount: 1,
        totalTimeSavedMs: Math.round(sequence.totalDurationMs * 0.3),
        lastUsed: Date.now(),
        createdAt: Date.now(),
      },
      confidenceScore: 0.5,
      version: 1,
    };

    // Enforce per-domain cap
    const domainStrategies = Array.from(this.strategies.values())
      .filter(s => s.trigger.domains[0] === domain);
    if (domainStrategies.length >= this.config.maxStrategiesPerDomain) {
      const evict = domainStrategies.sort((a, b) => a.stats.successRate - b.stats.successRate)[0];
      if (evict) this.strategies.delete(evict.id);
    }

    this.strategies.set(id, strategy);
  }

  private tryExtractFailure(sequence: ActionSequence): void {
    for (const action of sequence.actions) {
      if (!action.success) {
        const errorPattern = JSON.stringify(action.toolArgs).slice(0, 100);
        const key = `${action.agentId}:${action.toolName}:${errorPattern}`;
        const id = 'fail_' + crypto.createHash('md5').update(key).digest('hex').slice(0, 12);

        const existing = this.failurePatterns.get(id);
        if (existing) {
          existing.occurrences++;
          existing.lastSeen = Date.now();
        } else {
          this.failurePatterns.set(id, {
            id,
            failure: {
              toolName: `${action.agentId}:${action.toolName}`,
              errorPattern,
              context: sequence.outcome,
              domain: this.inferDomain(sequence.actions),
            },
            prevention: {
              alternative: `Avoid calling ${action.toolName} with these arguments.`,
              checkBefore: `Verify that ${action.toolName} is available and properly configured.`,
              warningMessage: `⚠ Previously ${action.toolName} failed ${3}+ times with similar arguments. Review the approach.`,
            },
            occurrences: 1,
            lastSeen: Date.now(),
          });
        }
      }
    }
  }

  private analyzeCurrentSequences(): void {
    const observations = this.currentSession.rawObservations;

    // Split into sequences by agent transitions
    let currentSequence: ObservedAction[] = [];
    let lastAgentId = '';

    for (const obs of observations) {
      if (obs.agentId !== lastAgentId && currentSequence.length > 0) {
        if (currentSequence.length >= this.config.minSequenceLength) {
          const allSuccess = currentSequence.every(a => a.success);
          this.tryExtractStrategy({
            actions: [...currentSequence],
            overallSuccess: allSuccess,
            totalDurationMs: currentSequence.reduce((sum, a) => sum + a.durationMs, 0),
            taskId: this.currentSession.sessionId,
            outcome: `Sequence by ${lastAgentId}: ${currentSequence.map(a => a.toolName).join(' → ')}`,
          });
        }
        currentSequence = [];
      }
      lastAgentId = obs.agentId;
      currentSequence.push(obs);
    }

    // Clear analyzed observations, keep only last 50 for context
    this.currentSession.rawObservations = observations.slice(-50);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private createSession(): LearningSession {
    return {
      sessionId: `learn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      startedAt: Date.now(),
      taskCount: 0,
      sequences: [],
      rawObservations: [],
    };
  }

  private inferDomain(actions: ObservedAction[]): StrategyDomain {
    const toolNames = actions.map(a => a.toolName).join(' ');
    if (/\b(test|verify|assert|expect|vitest|jest|mocha)\b/i.test(toolNames)) return 'testing';
    if (/\b(build|compile|tsc|webpack|vite|rollup)\b/i.test(toolNames)) return 'building';
    if (/\b(search|fetch|scrape|research|investigate)\b/i.test(toolNames)) return 'research';
    if (/\b(refactor|rename|extract|move|clean)\b/i.test(toolNames)) return 'refactoring';
    if (/\b(fix|bug|error|debug|repair|resolve)\b/i.test(toolNames)) return 'debugging';
    if (/\b(deploy|publish|release|ship|upload)\b/i.test(toolNames)) return 'deployment';
    return 'building'; // default
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being',
      'have','has','had','do','does','did','will','would','shall','should','may','might',
      'can','could','to','of','in','for','on','with','at','by','from','as','into','through',
      'and','or','but','not','no','yes','so','it','its','this','that','these','those']);
    return text
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 10);
  }

  private extractAgentRoles(actions: ObservedAction[]): AgentRoleId[] {
    return [...new Set(actions.map(a => a.agentId))];
  }

  private extractPromptHints(actions: ObservedAction[]): string[] {
    return actions
      .filter(a => a.success && a.toolName === 'write_file')
      .slice(0, 2)
      .map(a => `When generating ${a.toolArgs.path?.split('.').pop() || 'code'}, use ${a.toolName} directly.`);
  }

  private generateStrategyName(
    actions: ObservedAction[],
    domain: StrategyDomain
  ): string {
    const coreTools = [...new Set(actions.map(a => a.toolName))].slice(0, 4).join('→');
    return `${domain}: ${coreTools}`;
  }

  private findSimilarStrategy(
    toolSeq: Array<{ toolName: string; description: string }>,
    domain: StrategyDomain
  ): LearnedStrategy | null {
    const candidateNames = new Set(toolSeq.map(t => t.toolName));
    for (const [, s] of this.strategies) {
      if (s.trigger.domains[0] !== domain) continue;
      const existingNames = new Set(s.strategy.toolSequence.map(t => t.toolName));
      const overlap = [...candidateNames].filter(n => existingNames.has(n)).length;
      if (overlap >= Math.min(candidateNames.size, existingNames.size) * 0.7) {
        return s;
      }
    }
    return null;
  }

  startNewTask(): void {
    this.currentSession.taskCount++;
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  saveToDisk(): void {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        strategies: Array.from(this.strategies.values()),
        failurePatterns: Array.from(this.failurePatterns.values()),
      };

      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[SelfLearningEngine] Failed to save strategies:', error);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const data = JSON.parse(raw);

      if (Array.isArray(data.strategies)) {
        for (const s of data.strategies) {
          this.strategies.set(s.id, s);
        }
      }
      if (Array.isArray(data.failurePatterns)) {
        for (const f of data.failurePatterns) {
          this.failurePatterns.set(f.id, f);
        }
      }

      console.log(`[SelfLearningEngine] Loaded ${this.strategies.size} strategies, ${this.failurePatterns.size} failure patterns`);
    } catch (error) {
      console.warn('[SelfLearningEngine] Failed to load strategies:', error);
    }
  }

  private startAutoFlush(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.saveToDisk(), this.config.flushIntervalMs);
  }

  /** Get a human-readable summary of what the engine has learned. */
  getSummary(): string {
    const mature = Array.from(this.strategies.values())
      .filter(s => s.stats.usageCount >= this.config.maturityThreshold);

    const lines: string[] = [];
    lines.push(`## Self-Learning Engine Status`);
    lines.push(`- Strategies: ${this.strategies.size} total, ${mature.length} mature`);
    lines.push(`- Failure patterns: ${this.failurePatterns.size}`);
    lines.push(`- Session tasks: ${this.currentSession.taskCount}`);
    lines.push(`- Observations: ${this.currentSession.rawObservations.length}`);

    if (mature.length > 0) {
      lines.push(`\n### Top Strategies`);
      for (const s of mature.sort((a, b) => b.stats.successRate - a.stats.successRate).slice(0, 5)) {
        lines.push(
          `- **${s.name}** — success ${(s.stats.successRate * 100).toFixed(0)}%, ` +
          `used ${s.stats.usageCount}×, saved ~${Math.round(s.stats.totalTimeSavedMs / 1000)}s`
        );
      }
    }

    if (this.failurePatterns.size > 0) {
      const topFailures = Array.from(this.failurePatterns.values())
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 3);
      lines.push(`\n### Frequent Failure Patterns`);
      for (const f of topFailures) {
        lines.push(`- ${f.failure.toolName}: ${f.occurrences}× — ${f.prevention.warningMessage}`);
      }
    }

    return lines.join('\n');
  }

  cleanup(): void {
    this.saveToDisk();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  /** Statistics for the cockpit UI. */
  getStats(): {
    totalStrategies: number;
    matureStrategies: number;
    totalFailuresLearned: number;
    averageSuccessRate: number;
    topDomain: StrategyDomain | null;
  } {
    const all = Array.from(this.strategies.values());
    const mature = all.filter(s => s.stats.usageCount >= this.config.maturityThreshold);

    const domainCounts: Record<string, number> = {};
    for (const s of mature) {
      const d = s.trigger.domains[0];
      domainCounts[d] = (domainCounts[d] || 0) + 1;
    }
    let topDomain: StrategyDomain | null = null;
    let topCount = 0;
    for (const [d, c] of Object.entries(domainCounts)) {
      if (c > topCount) { topDomain = d as StrategyDomain; topCount = c; }
    }

    return {
      totalStrategies: this.strategies.size,
      matureStrategies: mature.length,
      totalFailuresLearned: this.failurePatterns.size,
      averageSuccessRate: all.length ? all.reduce((s, v) => s + v.stats.successRate, 0) / all.length : 0,
      topDomain,
    };
  }
}
