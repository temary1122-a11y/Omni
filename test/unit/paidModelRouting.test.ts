import * as path from 'path';
import { test, expect } from '../harness';
import { ModelRouter } from '../../src/routing/ModelRouter';
import { FreeModelCapabilityRegistry, ModelCapability } from '../../src/routing/ModelCapabilityRegistry';
import { ModelSelector } from '../../src/routing/ModelSelector';
import { ModelIndexer } from '../../src/routing/ModelIndexer';
import type { RequestClassification } from '../../src/routing/RequestClassifier';
import {
  classifyPriceLabel,
  priceLabelToTier,
  budgetMaxTier,
  isWithinBudget,
} from '../../src/routing/pricingTiers';

const repoRoot = path.resolve(__dirname, '..', '..');

const zero = { mmlu: 0, gsm8k: 0, humanEval: 0, mtBench: 0 };

function paidCatalog(): ModelCapability[] {
  return [
    { modelId: 'or-free', provider: 'openrouter', price: 'Free', contextWindow: 4000, benchmarks: zero, roleSuitability: ['coder', 'all'] },
    { modelId: 'or-cheap', provider: 'openrouter', price: 'cheap', contextWindow: 8000, benchmarks: zero, roleSuitability: ['coder', 'all'] },
    { modelId: 'or-mid', provider: 'openrouter', price: 'mid', contextWindow: 16000, benchmarks: zero, roleSuitability: ['coder', 'all'] },
    { modelId: 'or-premium', provider: 'openrouter', price: 'premium', contextWindow: 32000, benchmarks: zero, roleSuitability: ['coder', 'all'] },
  ];
}

function classification(complexity: 'simple' | 'medium' | 'complex'): RequestClassification {
  return {
    complexity, confidence: 0.8,
    dimensions: { tokenCount: 100, codePresence: false, toolUseDetection: false, reasoningComplexity: 0, domainSpecificity: 0, multiHopRequirements: false, creativityLevel: 0, precisionNeeds: 0, contextLengthRequirements: 4096, latencySensitivity: 0, costTolerance: 0, securityRequirements: 0, languageComplexity: 0, outputFormatConstraints: [] },
    reasoning: '',
  } as RequestClassification;
}

// ---- pricingTiers ----

test('P1 classifyPriceLabel maps per-token USD pricing to tiers', () => {
  expect(classifyPriceLabel(0, 0) === 'Free', 'zero price is Free');
  expect(classifyPriceLabel(NaN, NaN) === 'premium', 'unknown price defaults to premium (non-free)');
  expect(classifyPriceLabel(0.0000005) === 'cheap', `$0.5/1M should be cheap, got ${classifyPriceLabel(0.0000005)}`);
  expect(classifyPriceLabel(0.000005) === 'mid', `$5/1M should be mid, got ${classifyPriceLabel(0.000005)}`);
  expect(classifyPriceLabel(0.00005) === 'premium', `$50/1M should be premium, got ${classifyPriceLabel(0.00005)}`);
});

test('P2 budget→tier caps are correct and isWithinBudget enforces them', () => {
  expect(budgetMaxTier('free') === 'free', 'free budget caps at free');
  expect(budgetMaxTier('low') === 'cheap', 'low budget caps at cheap');
  expect(budgetMaxTier('normal') === 'mid', 'normal budget caps at mid');
  expect(budgetMaxTier('high') === 'premium', 'high budget caps at premium');
  expect(isWithinBudget('premium', 'low') === false, 'premium not allowed on low budget');
  expect(isWithinBudget('cheap', 'low') === true, 'cheap allowed on low budget');
  expect(isWithinBudget('Free', 'free') === true, 'free always allowed');
  expect(priceLabelToTier('Paid') === 'premium', 'legacy "Paid" label maps to premium');
});

// ---- ModelIndexer paid catalog ----

test('P3 refreshIndex indexes BOTH free and paid models with proper tiers', async () => {
  const indexer = new ModelIndexer();
  (indexer as any).apiKeys = { openrouter: 'k' };
  (indexer as any).fetcher = async (url: string) => {
    if (String(url).includes('openrouter')) {
      return { ok: true, json: async () => ({ data: [
        { id: 'free/model:free', context_length: 4096, pricing: { prompt: '0', completion: '0' } },
        { id: 'cheap/model', context_length: 8192, pricing: { prompt: '0.0000005', completion: '0.0000005' } },
        { id: 'premium/model', context_length: 128000, pricing: { prompt: '0.00005', completion: '0.0001' } },
      ] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  await indexer.refreshIndex();
  const models = indexer.getModels();
  const cheap = models.find((m) => m.modelId === 'cheap/model');
  const premium = models.find((m) => m.modelId === 'premium/model');
  expect(cheap !== undefined && cheap.price === 'cheap', `cheap model indexed with cheap tier, got ${cheap && cheap.price}`);
  expect(premium !== undefined && premium.price === 'premium', `premium model indexed with premium tier, got ${premium && premium.price}`);
  expect(models.find((m) => m.modelId === 'free/model:free') !== undefined, 'free model still indexed');
});

// ---- ModelRouter budget→tier routing (production forced-provider path) ----

function routerWithCatalog(budget: 'free' | 'low' | 'normal' | 'high'): ModelRouter {
  const router = new ModelRouter(budget, repoRoot);
  router.setPreferredProvider('openrouter');
  router.syncModels(paidCatalog());
  return router;
}

function forcedModel(router: ModelRouter, budget: 'free' | 'low' | 'normal' | 'high'): { modelId: string; costTier: string } {
  const sel = router.route(
    { phase: 'build', agentRole: 'coder', complexity: 'high', budget },
    { openrouter: 'k' }, 'prompt', 'openrouter'
  );
  return { modelId: sel.modelId, costTier: sel.costTier };
}

test('P4 high budget routes to the most powerful paid model in budget', () => {
  const router = routerWithCatalog('high');
  const sel = forcedModel(router, 'high');
  expect(sel.modelId === 'or-premium', `high budget should pick premium paid model, got ${sel.modelId}`);
  expect(sel.costTier === 'premium', `costTier should be premium, got ${sel.costTier}`);
});

test('P5 low budget never exceeds the cheap tier', () => {
  const router = routerWithCatalog('low');
  const sel = forcedModel(router, 'low');
  expect(sel.modelId === 'or-cheap', `low budget must cap at cheap, got ${sel.modelId}`);
  expect(sel.costTier === 'cheap', `costTier should be cheap, got ${sel.costTier}`);
});

test('P6 normal budget selects up to the mid tier', () => {
  const router = routerWithCatalog('normal');
  const sel = forcedModel(router, 'normal');
  expect(sel.modelId === 'or-mid', `normal budget should pick mid, got ${sel.modelId}`);
});

test('P7 free budget stays free-only even with a paid catalog', () => {
  const router = routerWithCatalog('free');
  const sel = forcedModel(router, 'free');
  expect(sel.costTier === 'free', `free budget must yield a free model, got ${sel.costTier} (${sel.modelId})`);
});

test('P8 credits exhausted forces free-only routing despite high budget request', () => {
  const router = routerWithCatalog('high');
  router.markCreditsExhausted();
  expect(router.isFreeOnly() === true, 'router must be free-only after credits exhausted');
  const sel = forcedModel(router, 'high');
  expect(sel.costTier === 'free', `after exhaustion, selection must be free, got ${sel.costTier} (${sel.modelId})`);
});

test('P9 candidate chain leads with paid model on high budget and keeps a free fallback', () => {
  const router = routerWithCatalog('high');
  const chain = router.getCandidateChain('coder');
  expect(chain.length > 0, 'chain should not be empty');
  expect(chain[0].modelId === 'or-premium', `chain should lead with the powerful paid model, got ${chain[0].modelId}`);
  expect(chain.some((c) => c.costTier === 'free'), 'chain must retain a free fallback for credits-exhausted degradation');
});

// ---- ModelSelector budget cap ----

test('P10 ModelSelector caps selection at the budget tier', () => {
  const registry = new FreeModelCapabilityRegistry(repoRoot);
  registry.addModels(paidCatalog());
  const lowSelector = new ModelSelector(registry, { budget: 'low', preferredProvider: 'openrouter' });
  const low = lowSelector.select(classification('complex'), 'coder', ['openrouter']);
  expect(isWithinBudget(low.costTier, 'low'), `low-budget selection must be within budget, got ${low.costTier}`);
  expect(low.costTier !== 'premium', `low budget must not pick premium, got ${low.costTier}`);

  const highSelector = new ModelSelector(registry, { budget: 'high', preferredProvider: 'openrouter' });
  const high = highSelector.select(classification('complex'), 'coder', ['openrouter']);
  expect(high.costTier === 'premium', `high budget should reach premium, got ${high.costTier}`);
});
