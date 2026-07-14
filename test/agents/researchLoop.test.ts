import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, afterEach } from '../harness';
import { EventBus } from '../../src/core/EventBus';
import { ResearchAgent } from '../../src/agents/ResearchAgent';
import type { HandoffContract } from '../../shared/types';
import { FakeModelRouter, type FakeStep } from '../fixtures/FakeModelRouter';
import { makeFakeSearch, type FakeSearch } from '../fixtures/fakeSearch';

const REPORT_REL = '.omniflow/tasks/t1/research-report.json';

// Track every temp dir a test creates so afterEach can always clean them up,
// keeping runs hermetic (no leak between tests, nothing written to repo root).
const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const d of createdTmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  createdTmpDirs.length = 0;
});

function makeContract(): HandoffContract {
  return {
    subtaskId: 't1',
    agentRole: 'researcher',
    successCriteria: ['produce a research report'],
    artifactTargets: [],
    contextPacket: {
      taskId: 't1',
      goal: 'build a vertical video tool',
      workspaceSnapshot: { fileTree: [], hasPackageJson: false, techStack: [] },
    },
  };
}

interface ResearchRun {
  manifest: any;
  toolCalls: any[];
  toolResults: any[];
  tmpDir: string;
  searchFn: FakeSearch;
}

async function runResearch(fakeSteps: FakeStep[], searchFn: FakeSearch): Promise<ResearchRun> {
  const eventBus = new EventBus();
  const fakeRouter = new FakeModelRouter(fakeSteps);
  const researchAgent = new ResearchAgent(fakeRouter, {}, eventBus);

  // Patch the live search with our deterministic fake.
  (researchAgent as any).searchQuery = searchFn.searchQuery;

  const toolCalls: any[] = [];
  const toolResults: any[] = [];
  eventBus.on('TOOL_CALL', (e: any) => toolCalls.push(e.payload));
  eventBus.on('TOOL_RESULT', (e: any) => toolResults.push(e.payload));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-test-'));
  createdTmpDirs.push(tmpDir);
  const manifest = await researchAgent.execute(makeContract(), tmpDir);

  return { manifest, toolCalls, toolResults, tmpDir, searchFn };
}

test('E1 happy-path research loop writes a valid report with both sources', async () => {
  const q1 = 'how to structure a typescript library';
  const q2 = 'typescript library testing strategies';
  const finalJson = JSON.stringify({
    summary: 'Vertical video tools should prioritise portrait UX and fast rendering.',
    terms: ['portrait', 'short-form'],
    bestPractices: ['Optimise for mobile', 'Keep clips under 60s'],
    patterns: ['Reactive feed', 'Edge transcoding'],
    sources: ['https://example.com/1', 'https://example.com/2'],
  });
  const fakeSteps: FakeStep[] = [
    { toolCalls: [{ name: 'web_search', arguments: { query: q1 } }] },
    { toolCalls: [{ name: 'web_search', arguments: { query: q2 } }] },
    { toolCalls: [{ name: 'write_file', arguments: { path: REPORT_REL, content: finalJson } }] },
  ];

  const searchFn = makeFakeSearch();
  const { manifest, tmpDir } = await runResearch(fakeSteps, searchFn);

  expect(manifest.artifacts.length > 0, `manifest should contain at least one artifact (got ${manifest.artifacts.length})`);

  const reportPath = path.join(tmpDir, REPORT_REL);
  expect(fs.existsSync(reportPath), 'research-report.json should exist in tmpDir');

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  expect(
    report.sources.includes('https://example.com/1') && report.sources.includes('https://example.com/2'),
    'report.sources should include both searched urls'
  );
  expect(searchFn.calls === 2, `searchQuery should be called exactly twice (got ${searchFn.calls})`);
});

test('E2 search-saturation loop terminates and dedupes repeated queries', async () => {
  const q = 'same query';
  const fakeSteps: FakeStep[] = [];
  for (let i = 0; i < 15; i++) {
    fakeSteps.push({ toolCalls: [{ name: 'web_search', arguments: { query: q } }] });
  }

  const searchFn = makeFakeSearch();
  const { toolResults, toolCalls } = await runResearch(fakeSteps, searchFn);

  expect(searchFn.calls === 1, `searchQuery should be called exactly ONCE via dedupe (got ${searchFn.calls})`);
  expect(toolCalls.length <= 36, `total tool-call iterations should stay within hard cap of 36 (got ${toolCalls.length})`);

  const outputs = toolResults.map((r) => r.output || '').join('\n');
  expect(/duplicate|no new results/i.test(outputs), 'executor should emit a duplicate / no-new-results message on repeats');
});

test('E3 fetch_page strips HTML and returns readable text', async () => {
  const q = 'vertical video tool';
  const url = 'https://example.com/page1';
  const finalJson = JSON.stringify({
    summary: 's',
    terms: ['a'],
    bestPractices: ['b'],
    patterns: ['c'],
    sources: [url],
  });
  const fakeSteps: FakeStep[] = [
    { toolCalls: [{ name: 'web_search', arguments: { query: q } }] },
    { toolCalls: [{ name: 'fetch_page', arguments: { url } }] },
    { toolCalls: [{ name: 'write_file', arguments: { path: REPORT_REL, content: finalJson } }] },
  ];

  const searchFn = makeFakeSearch();
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      text: async () => '<html><script>bad()</script><body><p>Hello World</p></body></html>',
    }) as any;

  try {
    const { toolResults } = await runResearch(fakeSteps, searchFn);
    const fetchResult = toolResults.find((r) => r.toolName === 'fetch_page');
    expect(!!fetchResult, 'fetch_page tool result should be captured');
    const out = String(fetchResult.output);
    expect(out.includes('Hello World'), 'fetch_page output should contain extracted text "Hello World"');
    expect(!out.includes('<script'), 'fetch_page output should NOT contain raw <script> tags (HTML stripped)');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test('E4 headless loop: fake LLM infinitely emits web_search but must stop (no hang)', async () => {
  // A scripted LLM that NEVER stops searching: 15 DISTINCT queries, each of
  // which the (faked) search returns NO new results for. This mimics a model
  // that loops on web_search forever. The runtime hard cap (maxIterations: 12,
  // retried up to 3x) must terminate it instead of hanging the test.
  const fakeSteps: FakeStep[] = [];
  for (let i = 0; i < 15; i++) {
    fakeSteps.push({ toolCalls: [{ name: 'web_search', arguments: { query: `distinct angle ${i}` } }] });
  }

  // searchQuery returns [] (no new results) for EVERY query -> every search is "stale".
  let searchCalls = 0;
  const searchFn: FakeSearch = {
    get calls() { return searchCalls; },
    seen: new Set<string>(),
    searchQuery: async () => { searchCalls++; return []; },
  };

  const { toolCalls, toolResults } = await runResearch(fakeSteps, searchFn);

  // Must have terminated well within the hard cap (12 iterations x 3 retries).
  expect(toolCalls.length <= 36, `loop must terminate; tool-calls=${toolCalls.length} exceeded cap of 36`);
  const outputs = toolResults.map((r) => r.output || '').join('\n');
  expect(/no new results|duplicate/i.test(outputs), 'stale-search guard should fire (no new results / duplicate)');
});

test('E5 report persistence failures reject instead of returning a phantom artifact', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-test-'));
  createdTmpDirs.push(parent);
  const invalidRoot = path.join(parent, 'workspace-file');
  fs.writeFileSync(invalidRoot, 'not a directory', 'utf-8');
  const eventBus = new EventBus();
  const fakeRouter = new FakeModelRouter([
    { content: 'unable to use tools' },
    { content: 'unable to use tools' },
    { content: 'unable to use tools' },
  ]);
  const researchAgent = new ResearchAgent(fakeRouter, {}, eventBus);
  (researchAgent as any).searchQuery = async () => [];

  let caught: unknown;
  try {
    await researchAgent.execute(makeContract(), invalidRoot);
  } catch (error) {
    caught = error;
  }

  expect(caught instanceof Error, 'research execution should reject when its report cannot be written');
  expect(
    caught instanceof Error && caught.message.includes('Unable to persist research report'),
    'research persistence error should include report context'
  );
});
