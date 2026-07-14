import { describe, expect, it } from 'vitest';
import { IntentRouter } from '../../src/core/IntentRouter';
import { ModelRouter } from '../../src/routing/ModelRouter';
import { FakeModelRouter } from '../fixtures/FakeModelRouter';

const KEYS: Record<string, string> = {};

/** ModelRouter whose call() always rejects, forcing the heuristic fallback. */
class ThrowingRouter extends ModelRouter {
  async call(): Promise<never> {
    throw new Error('no provider');
  }
}

function routerReturning(content: string): ModelRouter {
  return new FakeModelRouter([{ content }]);
}

describe('IntentRouter.classify (LLM path)', () => {
  it('parses a well-formed JSON classification', async () => {
    const router = routerReturning(
      JSON.stringify({
        intent: 'code',
        confidence: 0.9,
        reasoning: 'build a thing',
        requiresBuild: true,
        decomposition: ['a', 'b'],
      })
    );
    const r = new IntentRouter(router, KEYS);
    const d = await r.classify('build a REST API');
    expect(d.intent).toBe('code');
    expect(d.confidence).toBe(0.9);
    expect(d.requiresBuild).toBe(true);
    expect(d.decomposition).toEqual(['a', 'b']);
    expect(d.heuristic).toBe(false);
  });

  it('extracts JSON out of a fenced code block', async () => {
    const router = routerReturning('```json\n{"intent":"research","confidence":0.6}\n```');
    const r = new IntentRouter(router, KEYS);
    const d = await r.classify('analyze this repo');
    expect(d.intent).toBe('research');
    expect(d.confidence).toBe(0.6);
    // requiresBuild defaults to true for research when not provided.
    expect(d.requiresBuild).toBe(true);
  });

  it('normalizes synonym intents (e.g. "investigate" -> research)', async () => {
    const router = routerReturning('{"intent":"investigate"}');
    const r = new IntentRouter(router, KEYS);
    const d = await r.classify('take a look');
    expect(d.intent).toBe('research');
  });

  it('reroutes a chat classification to research when live web data is needed', async () => {
    const router = routerReturning('{"intent":"chat","confidence":0.9}');
    const r = new IntentRouter(router, KEYS);
    const d = await r.classify('what is the latest news today');
    expect(d.intent).toBe('research');
    expect(d.confidence).toBe(0.95);
    expect(d.requiresBuild).toBe(false);
  });

  it('falls back to the heuristic when the parsed JSON has no string intent', async () => {
    const router = routerReturning('{"confidence":0.3}');
    const r = new IntentRouter(router, KEYS);
    const d = await r.classify('build a todo app');
    expect(d.heuristic).toBe(true);
    expect(d.intent).toBe('code');
  });

  it('falls back to the heuristic when the LLM call throws', async () => {
    const r = new IntentRouter(new ThrowingRouter(), KEYS);
    const d = await r.classify('refactor the auth module');
    expect(d.heuristic).toBe(true);
    expect(d.intent).toBe('refactor');
  });
});

describe('IntentRouter.requiresLiveWeb', () => {
  const r = new IntentRouter(new ThrowingRouter(), KEYS);

  it('detects English live-data signals', () => {
    expect(r.requiresLiveWeb('find the current price of BTC')).toBe(true);
    expect(r.requiresLiveWeb('LATEST AI models')).toBe(true);
  });

  it('detects non-English (Russian) live-data signals', () => {
    expect(r.requiresLiveWeb('какие сегодня новости')).toBe(true);
  });

  it('returns false for a generic build request', () => {
    expect(r.requiresLiveWeb('create a button component')).toBe(false);
  });
});

describe('IntentRouter heuristic fallback', () => {
  const r = new IntentRouter(new ThrowingRouter(), KEYS);

  it('routes plain questions to chat', async () => {
    const d = await r.classify('what is a closure?');
    expect(d.intent).toBe('chat');
    expect(d.requiresBuild).toBe(false);
  });

  it('routes a question carrying a build verb to code', async () => {
    const d = await r.classify('how do I build a discord bot');
    expect(d.intent).toBe('code');
    expect(d.requiresBuild).toBe(true);
  });

  it('routes imperative build verbs to code', async () => {
    const d = await r.classify('create a landing page');
    expect(d.intent).toBe('code');
  });

  it('routes port-style migrate requests to migrate', async () => {
    const d = await r.classify('port this module to Python');
    expect(d.intent).toBe('migrate');
  });

  it('defaults to chat when there is no clear signal', async () => {
    const d = await r.classify('the quick brown fox');
    expect(d.intent).toBe('chat');
    expect(d.confidence).toBe(0.5);
  });
});
