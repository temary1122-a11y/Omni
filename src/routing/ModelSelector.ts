import type { ModelCapability, ModelCapabilityRegistry } from './ModelCapabilityRegistry';
import type { RequestClassification } from './RequestClassifier';
import type { AgentRole } from '../../shared/types';
import type { Provider } from './ModelRouter';
import { budgetMaxTierRank, priceLabelToTier, tierRank, isWithinBudget } from './pricingTiers';

export interface ModelSelection {
  provider: Provider;
  modelId: string;
  costTier: 'free' | 'cheap' | 'mid' | 'premium';
  maxTokens: number;
  reasoning: string;
  fallbackChain: ModelSelection[];
  estimatedCost: number;
  estimatedSavings: number;
}

export interface SelectionConfig {
  budget: 'free' | 'low' | 'normal' | 'high';
  preferredProvider: Provider;
  enableFallback: boolean;
  maxFallbackDepth: number;
}

export class ModelSelector {
  private registry: ModelCapabilityRegistry;
  private config: SelectionConfig;

  constructor(registry: ModelCapabilityRegistry, config?: Partial<SelectionConfig>) {
    this.registry = registry;
    this.config = {
      budget: 'free',
      preferredProvider: 'openrouter',
      enableFallback: true,
      maxFallbackDepth: 3,
      ...config,
    };
  }

  select(
    classification: RequestClassification,
    agentRole: AgentRole,
    availableProviders: Provider[]
  ): ModelSelection {
    const primarySelection = this.selectPrimary(classification, agentRole, availableProviders);
    const fallbackChain = this.buildFallbackChain(classification, agentRole, availableProviders, primarySelection);
    
    const estimatedCost = this.estimateCost(primarySelection);
    const estimatedSavings = this.estimateSavings(primarySelection, classification);

    return {
      ...primarySelection,
      fallbackChain,
      estimatedCost,
      estimatedSavings,
    };
  }

  private selectPrimary(
    classification: RequestClassification,
    agentRole: AgentRole,
    availableProviders: Provider[]
  ): {
    provider: Provider;
    modelId: string;
    costTier: 'free' | 'cheap' | 'mid' | 'premium';
    maxTokens: number;
    reasoning: string;
  } {
    const bestForRole = this.registry.getBestModelForRole(agentRole);

    // On a FREE budget we must never resolve to a paid model — pick the best
    // FREE model for the role (falling back to any free model). This honours the
    // "free" contract even when a paid model scores a higher benchmark.
    if (this.config.budget === 'free') {
      const bestFree = this.bestFreeForRole(agentRole, classification);
      if (bestFree) return this.buildSelection(bestFree, classification);
      // No free model exists at all — fall through to the default selection.
    }

    // Non-free budget: pick the best model for the role whose cost tier is within
    // the budget (low→cheap, normal→mid, high→premium). This lets powerful paid
    // models be selected while never exceeding the configured budget tier.
    const bestWithinBudget = this.bestModelForRoleWithinBudget(agentRole, classification);
    if (bestWithinBudget) {
      return this.buildSelection(bestWithinBudget, classification);
    }

    // Fallback to role-based selection when nothing matched the budget filter.
    if (bestForRole && isWithinBudget(bestForRole.price, this.config.budget)) {
      return this.buildSelection(bestForRole, classification);
    }

    // Ultimate fallback to any free model
    const freeModels = this.registry.getModels().filter((m) => m.price === 'Free');
    if (freeModels.length > 0) {
      return this.buildSelection(freeModels[0], classification);
    }

    // If no models in registry, use default
    return this.buildDefaultSelection(agentRole, classification);
  }

  /**
   * Best model for a role whose cost tier fits the configured (non-free) budget.
   * Ranks by benchmark first (real capability when populated); ties break toward
   * the most powerful affordable tier for medium/complex tasks and the cheapest
   * tier for simple tasks.
   */
  private bestModelForRoleWithinBudget(
    agentRole: AgentRole,
    classification: RequestClassification
  ): ModelCapability | undefined {
    const maxRank = budgetMaxTierRank(this.config.budget);
    const pool = this.registry.getModels().filter(
      (m) =>
        tierRank(priceLabelToTier(m.price)) <= maxRank &&
        m.roleSuitability.some(
          (r) => r.toLowerCase() === agentRole.toLowerCase() || r.toLowerCase() === 'all'
        )
    );
    if (pool.length === 0) return undefined;

    pool.sort((a, b) => {
      if (b.benchmarks.mtBench !== a.benchmarks.mtBench) {
        return b.benchmarks.mtBench - a.benchmarks.mtBench;
      }
      const ra = tierRank(priceLabelToTier(a.price));
      const rb = tierRank(priceLabelToTier(b.price));
      if (rb !== ra) return classification.complexity === 'simple' ? ra - rb : rb - ra;
      const contextScoreA = this.contextPreferenceScore(a.contextWindow, classification);
      const contextScoreB = this.contextPreferenceScore(b.contextWindow, classification);
      if (contextScoreB !== contextScoreA) return contextScoreB - contextScoreA;
      return a.modelId.localeCompare(b.modelId);
    });
    return pool[0];
  }

  /**
   * Best FREE model for a role (role-specific first, then any free model),
   * sorted by MT-Bench. Used to honour a free budget even when a paid model
   * would otherwise win on benchmark score.
   */
  private bestFreeForRole(
    agentRole: AgentRole,
    classification: RequestClassification
  ): ModelCapability | undefined {
    const freeForRole = this.registry
      .getModels()
      .filter(
        (m) =>
          (m.price === 'Free' || m.price === 'free') &&
          m.roleSuitability.some(
            (r) => r.toLowerCase() === agentRole.toLowerCase() || r.toLowerCase() === 'all'
          )
      )
      .sort((a, b) => {
        if (b.benchmarks.mtBench !== a.benchmarks.mtBench) {
          return b.benchmarks.mtBench - a.benchmarks.mtBench;
        }
        const contextScoreA = this.contextPreferenceScore(a.contextWindow, classification);
        const contextScoreB = this.contextPreferenceScore(b.contextWindow, classification);
        if (contextScoreB !== contextScoreA) return contextScoreB - contextScoreA;
        return a.modelId.localeCompare(b.modelId);
      });
    if (freeForRole.length > 0) return freeForRole[0];

    const anyFree = this.registry
      .getModels()
      .filter((m) => m.price === 'Free' || m.price === 'free')
      .sort((a, b) => {
        if (b.benchmarks.mtBench !== a.benchmarks.mtBench) {
          return b.benchmarks.mtBench - a.benchmarks.mtBench;
        }
        return b.contextWindow - a.contextWindow;
      });
    return anyFree[0];
  }

  private buildFallbackChain(
    classification: RequestClassification,
    agentRole: AgentRole,
    availableProviders: Provider[],
    primary: Omit<ModelSelection, 'fallbackChain' | 'estimatedCost' | 'estimatedSavings'>
  ): ModelSelection[] {
    if (!this.config.enableFallback) return [];

    const chain: ModelSelection[] = [];
    const usedModels = new Set([primary.modelId]);

    // Get all models sorted by suitability
    const allModels = this.registry.getModels();
    
    // Build fallback chain based on complexity and role
    for (const model of allModels) {
      if (chain.length >= this.config.maxFallbackDepth) break;
      if (usedModels.has(model.modelId)) continue;
      if (!isWithinBudget(model.price, this.config.budget)) continue;

      const selection = this.buildSelection(model, classification);
      chain.push({
        provider: selection.provider,
        modelId: selection.modelId,
        costTier: selection.costTier,
        maxTokens: selection.maxTokens,
        reasoning: selection.reasoning,
        fallbackChain: [],
        estimatedCost: 0,
        estimatedSavings: 0,
      });
      usedModels.add(model.modelId);
    }

    return chain;
  }

  private buildSelection(
    model: ModelCapability,
    classification: RequestClassification
  ): {
    provider: Provider;
    modelId: string;
    costTier: 'free' | 'cheap' | 'mid' | 'premium';
    maxTokens: number;
    reasoning: string;
  } {
    const provider = this.mapProvider(model.provider);
    const maxTokens = this.determineMaxTokens(model, classification);
    const costTier = this.mapCostTier(model.price);
    const reasoning = this.explainSelection(model, classification);

    return {
      provider,
      modelId: model.modelId,
      costTier,
      maxTokens,
      reasoning,
    };
  }

  private buildDefaultSelection(
    agentRole: AgentRole,
    classification: RequestClassification
  ): {
    provider: Provider;
    modelId: string;
    costTier: 'free' | 'cheap' | 'mid' | 'premium';
    maxTokens: number;
    reasoning: string;
  } {
    // Default fallback models based on role
    const defaults: Record<AgentRole, string> = {
      orchestrator: 'meta-llama/llama-3.1-8b-instruct:free',
      clarifier: 'meta-llama/llama-3.2-3b-instruct:free',
      researcher: 'google/gemini-2.0-flash-001:free',
      planner: 'meta-llama/llama-3.1-8b-instruct:free',
      coder: 'qwen/qwen-2.5-coder-32b-instruct:free',
      auditor: 'meta-llama/llama-3.2-3b-instruct:free',
      security: 'meta-llama/llama-3.2-3b-instruct:free',
      verifier: 'meta-llama/llama-3.2-3b-instruct:free',
      'pre-installer': 'meta-llama/llama-3.2-3b-instruct:free',
      'tool-manager': 'meta-llama/llama-3.2-3b-instruct:free',
      'context-agent': 'meta-llama/llama-3.2-3b-instruct:free',
    };

    const modelId = defaults[agentRole] || defaults.orchestrator;
    const maxTokens = classification.dimensions.contextLengthRequirements;

    return {
      provider: 'openrouter',
      modelId,
      costTier: 'free',
      maxTokens,
      reasoning: 'Using default model (registry unavailable)',
    };
  }

  private mapProvider(providerName: string): Provider {
    const normalized = providerName.toLowerCase();
    
    if (normalized.includes('kilo')) return 'kilo-gateway';
    if (normalized.includes('codik')) return 'codik';
    if (normalized.includes('ollama')) return 'ollama';
    if (normalized.includes('openrouter')) return 'openrouter';
    
    return 'openrouter'; // Default
  }

  private mapCostTier(price: string): 'free' | 'cheap' | 'mid' | 'premium' {
    if (price.toLowerCase() === 'free') return 'free';
    if (price.toLowerCase().includes('cheap')) return 'cheap';
    if (price.toLowerCase().includes('mid')) return 'mid';
    return 'premium';
  }

  private determineMaxTokens(
    model: ModelCapability,
    classification: RequestClassification
  ): number {
    // Use model's context window, but cap based on classification
    const modelLimit = model.contextWindow;
    const required = classification.dimensions.contextLengthRequirements;
    
    return Math.min(modelLimit, required);
  }

  private contextPreferenceScore(contextWindow: number, classification: RequestClassification): number {
    const required = classification.dimensions.contextLengthRequirements;
    const ratio = contextWindow / Math.max(required, 1);
    const toolHeavy = classification.dimensions.toolUseDetection || classification.dimensions.codePresence || classification.dimensions.multiHopRequirements;

    if (classification.complexity === 'simple' && !toolHeavy) {
      return 1 / Math.max(contextWindow, 1);
    }

    if (toolHeavy || classification.complexity === 'complex') {
      return ratio >= 1 ? ratio : ratio * 0.5;
    }

    return Math.abs(1 - ratio);
  }

  private explainSelection(
    model: ModelCapability,
    classification: RequestClassification
  ): string {
    const reasons: string[] = [];
    
    reasons.push(`Selected ${model.modelId} (${model.provider})`);
    reasons.push(`Price: ${model.price}`);
    reasons.push(`Context: ${model.contextWindow} tokens`);
    reasons.push(`Benchmarks: MMLU=${model.benchmarks.mmlu}, MT-Bench=${model.benchmarks.mtBench}`);
    
    if (classification.complexity !== 'simple') {
      reasons.push(`Matched complexity: ${classification.complexity}`);
    }
    
    return reasons.join('. ');
  }

  private estimateCost(selection: {
    provider: Provider;
    modelId: string;
    costTier: 'free' | 'cheap' | 'mid' | 'premium';
    maxTokens: number;
    reasoning: string;
  }): number {
    // Rough cost estimation (will be refined with actual pricing data)
    const baseCostPer1kTokens = {
      free: 0,
      cheap: 0.0001,
      mid: 0.001,
      premium: 0.01,
    };

    const avgTokens = selection.maxTokens / 2; // Assume average usage is half of max
    return (baseCostPer1kTokens[selection.costTier] * avgTokens) / 1000;
  }

  private estimateSavings(
    selection: {
      provider: Provider;
      modelId: string;
      costTier: 'free' | 'cheap' | 'mid' | 'premium';
      maxTokens: number;
      reasoning: string;
    },
    classification: RequestClassification
  ): number {
    // Compare against always using premium model
    const premiumCost = 0.01; // $0.01 per 1k tokens for premium
    const avgTokens = selection.maxTokens / 2;
    const baselineCost = (premiumCost * avgTokens) / 1000;
    const actualCost = this.estimateCost(selection);

    const savings = baselineCost - actualCost;
    const savingsPercent = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

    return savingsPercent;
  }

  updateConfig(config: Partial<SelectionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SelectionConfig {
    return { ...this.config };
  }
}
