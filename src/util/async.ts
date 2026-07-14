/**
 * Shared async helpers used across agents and routers.
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackoffOptions {
  /** Delay for the first backoff step (attempt 0), in milliseconds. Default 1000. */
  baseMs?: number;
  /** Upper bound on the computed delay. Default Infinity (no cap). */
  maxMs?: number;
  /** Growth factor per attempt. Default 2 (exponential). */
  factor?: number;
}

/**
 * Exponential backoff delay for a zero-based retry `attempt`:
 * `min(baseMs * factor^attempt, maxMs)`.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = Infinity, factor = 2 } = options;
  return Math.min(baseMs * Math.pow(factor, attempt), maxMs);
}
