import { test, expect } from '../harness';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelIndexer } from '../../src/routing/ModelIndexer';

test('C static fallback models are loaded from registry', () => {
  const indexer = new ModelIndexer();
  const models = (indexer as any).getStaticFallbackModels() as Array<{ modelId: string }>;

  const withDeadSlug = models.filter((m) => m.modelId.includes('gemini-2.0-flash-exp:free'));
  expect(
    withDeadSlug.length === 0,
    `no static fallback model should contain dead slug gemini-2.0-flash-exp:free (found: ${withDeadSlug.map((m) => m.modelId).join(', ')})`
  );

  expect(
    models.length > 0,
    'static fallback models should be available'
  );
});

test('C loadIndex reads a JSON model catalog from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-model-index-'));
  const indexPath = path.join(dir, 'model-index.md');
  try {
    fs.writeFileSync(
      indexPath,
      JSON.stringify([
        {
          modelId: 'test/provider-model:free',
          provider: 'openrouter',
          price: 'free',
          contextWindow: 4096,
          benchmarks: { mmlu: 1, gsm8k: 2, humanEval: 3, mtBench: 4 },
          roleSuitability: ['coder'],
        },
      ]),
      'utf-8'
    );

    const indexer = new ModelIndexer();
    await indexer.loadIndex(indexPath);

    const models = indexer.getModels();
    expect(models.some((m) => m.modelId === 'test/provider-model:free'), 'loadIndex should read the file-backed model catalog');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
