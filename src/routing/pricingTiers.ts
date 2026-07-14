/**
 * Shared cost-tier helpers used by the model indexer, router and selector so
 * that "powerful paid models via the same routers" can be indexed and selected
 * consistently with the budget the user configured.
 *
 * A model's `price` field is a human-readable label ('Free' | 'cheap' | 'mid' |
 * 'premium', case-insensitive). Budgets map to a maximum tier a request may use:
 *   free   → free only
 *   low    → up to cheap
 *   normal → up to mid
 *   high   → up to premium
 */

export type CostTier = 'free' | 'cheap' | 'mid' | 'premium';
export type Budget = 'free' | 'low' | 'normal' | 'high';

const TIER_ORDER: CostTier[] = ['free', 'cheap', 'mid', 'premium'];

/** Numeric rank of a tier (free = 0 … premium = 3). */
export function tierRank(tier: CostTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** Map a stored `price` label to a normalized cost tier. Non-free/unknown → premium. */
export function priceLabelToTier(price: string | undefined | null): CostTier {
  const p = (price ?? '').toLowerCase();
  if (p === 'free') return 'free';
  if (p.includes('cheap')) return 'cheap';
  if (p.includes('mid')) return 'mid';
  return 'premium';
}

/** The most expensive tier a given budget is allowed to select. */
export function budgetMaxTier(budget: Budget): CostTier {
  switch (budget) {
    case 'free':
      return 'free';
    case 'low':
      return 'cheap';
    case 'normal':
      return 'mid';
    case 'high':
      return 'premium';
    default:
      return 'free';
  }
}

export function budgetMaxTierRank(budget: Budget): number {
  return tierRank(budgetMaxTier(budget));
}

/** True when a model priced at `price` is affordable under `budget`. */
export function isWithinBudget(price: string, budget: Budget): boolean {
  return tierRank(priceLabelToTier(price)) <= budgetMaxTierRank(budget);
}

/**
 * Classify a per-token USD price into a tier label suitable for storage in the
 * capability registry. Prices are per-token (as returned by OpenRouter-style
 * `/models` endpoints); thresholds below are expressed per 1M tokens:
 *   $0            → Free
 *   ≤ $1  / 1M    → cheap
 *   ≤ $10 / 1M    → mid
 *   > $10 / 1M    → premium
 */
export function classifyPriceLabel(
  promptPricePerToken: number,
  completionPricePerToken?: number
): string {
  const promptFinite = Number.isFinite(promptPricePerToken);
  const completionFinite = Number.isFinite(completionPricePerToken as number);
  const prompt = promptFinite ? promptPricePerToken : 0;
  const completion = completionFinite ? (completionPricePerToken as number) : 0;

  const isFree = promptFinite && prompt === 0 && (!completionFinite || completion === 0);
  if (isFree) return 'Free';

  // No usable numeric price at all → be conservative and treat as premium so it is
  // only ever selected on a high budget (never mistaken for a cheap model).
  if (!promptFinite && !completionFinite) return 'premium';

  // Use the higher of prompt/completion price as the driver.
  const perMillion = Math.max(prompt, completion) * 1_000_000;

  if (perMillion <= 1) return 'cheap';
  if (perMillion <= 10) return 'mid';
  return 'premium';
}
