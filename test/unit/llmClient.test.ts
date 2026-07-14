import { test, expect } from '../harness';
import { LLMClient } from '../../src/routing/LLMClient';

test('D fallback provider returns structured failure JSON without fake code', async () => {
  const client = new LLMClient();
  const res = await client.complete(
    { provider: 'openrouter', model: 'x', maxTokens: 200 } as any,
    [{ role: 'user', content: 'write the app entrypoint' }],
    {},
    {}
  );

  expect(res.usedFallback === true, `usedFallback should be true, got ${res.usedFallback}`);
  expect(res.error?.includes('no API key for openrouter') === true, `error should explain missing API key, got ${res.error}`);
  let parsed: any;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    throw new Error('fallback content is not valid JSON: ' + res.content);
  }
  expect(parsed._fallbackError === true, 'fallback JSON should be marked as an error');
  expect(parsed.reason?.includes('no API key') === true, 'fallback JSON should explain the failure');
  expect(res.content.includes('export const app = { ready: true }') === false, 'fallback must not emit fake generated code');
});
