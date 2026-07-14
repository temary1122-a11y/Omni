import { describe, expect, it, vi } from 'vitest';
import { sleep, backoffDelayMs } from '../../../src/util/async';

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      const p = sleep(1000).then(spy);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffDelayMs(0, { baseMs: 1000, maxMs: 5000 })).toBe(1000);
    expect(backoffDelayMs(1, { baseMs: 1000, maxMs: 5000 })).toBe(2000);
    expect(backoffDelayMs(2, { baseMs: 1000, maxMs: 5000 })).toBe(4000);
  });

  it('caps the delay at maxMs', () => {
    expect(backoffDelayMs(3, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
    expect(backoffDelayMs(10, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });

  it('defaults to base 1000ms, factor 2, and no cap', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(3)).toBe(8000);
  });

  it('honors a custom factor', () => {
    expect(backoffDelayMs(2, { baseMs: 100, factor: 3 })).toBe(900);
  });
});
