import { test, expect } from '../harness';
import { isWithinBoundary } from '../../src/core/ToolRegistry';
import { ModelIndexer } from '../../src/routing/ModelIndexer';

test('boundary on a single FILE also allows writes into its parent directory', () => {
  const root = '/workspace';
  // boundary is a single FILE, as produced by OmniOrchestrator.runCodersParallel
  const boundary = ['src/https-github-com-temary1122-a11y.ts'];
  expect(isWithinBoundary(root, boundary, 'src/https-github-com-temary1122-a11y.ts') === true, 'the file itself allowed');
  expect(isWithinBoundary(root, boundary, 'src/other.ts') === true, 'other file in same dir allowed');
  expect(isWithinBoundary(root, boundary, 'package.json') === true, 'project root file (sibling of src) allowed via parent dir');
  expect(isWithinBoundary(root, boundary, 'index.html') === true, 'index.html at root allowed');
  expect(isWithinBoundary(root, boundary, '../outside.ts') === false, 'path escaping workspace blocked');
});

test('model indexer never selects the dead qwen coder free model', async () => {
  const indexer = new ModelIndexer();
  (indexer as any).apiKeys = { openrouter: 'k', 'kilo-gateway': 'k' };
  // stub fetcher returns only a fresh free coder model
  (indexer as any).fetcher = async (url: string) => {
    if (String(url).includes('openrouter')) {
      return { ok: true, json: async () => ({ data: [
        { id: 'meta-llama/llama-3.3-70b-instruct:free', context_length: 32768, pricing: { prompt: '0', completion: '0' } },
        { id: 'some/paid-model', context_length: 8192, pricing: { prompt: '0.001', completion: '0.002' } },
      ] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  await indexer.refreshIndex();
  const models = indexer.getModels();
  expect(models.find((m) => m.modelId === 'qwen/qwen-2.5-coder-32b-instruct:free') === undefined, 'dead qwen must be gone');
  expect(models.find((m) => m.modelId === 'meta-llama/llama-3.3-70b-instruct:free') !== undefined, 'live free llama present');
  // Paid models are now indexed (blocker #2) so budget=normal/high can route to them.
  const paid = models.find((m) => m.modelId === 'some/paid-model');
  expect(paid !== undefined, 'paid model must now be indexed for paid budgets');
  expect(paid !== undefined && paid.price !== 'Free', 'paid model must carry a non-free cost tier');
});
