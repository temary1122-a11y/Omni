import { describe, expect, it, afterEach } from 'vitest';
import { AuditAgent } from '../../src/agents/AuditAgent';
import { FakeModelRouter } from '../fixtures/FakeModelRouter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HandoffContract, ContextPacket } from '../../shared/types';
import { EventBus } from '../../src/core/EventBus';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeWs(files: Record<string, string>): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp!, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return tmp!;
}

function makeContract(ws: string, files: string[], subtaskId = 'audit_t1'): HandoffContract {
  const contextPacket: ContextPacket = { taskId: 't1', goal: 'g', workspaceSnapshot: { fileTree: [] } } as ContextPacket;
  return {
    subtaskId,
    agentRole: 'auditor',
    successCriteria: ['Audit complete'],
    artifactTargets: files.map((f) => ({ filePath: f, contentType: 'code' as const })),
    contextPacket,
  };
}

describe('AuditAgent', () => {
  it('no router → exact heuristic behavior, FAIL on missing file', async () => {
    const ws = makeWs({ 'a.ts': 'export const x = 1;\n' });
    const agent = new AuditAgent();
    const manifest = await agent.execute(makeContract(ws, ['a.ts', 'missing.ts']), ws);
    const report = JSON.parse(manifest.artifacts[0].content) as any;
    expect(report.verdict).toBe('FAIL');
    expect(report.criteria.some((c: any) => c.criterion.includes('missing.ts exists') && c.passed === false)).toBe(true);
  });

  it('no router → NEEDS_REVIEW when only stub markers present', async () => {
    const ws = makeWs({ 'a.ts': '// TODO: implement\n// FIXME later\n' });
    const agent = new AuditAgent();
    const manifest = await agent.execute(makeContract(ws, ['a.ts']), ws);
    const report = JSON.parse(manifest.artifacts[0].content) as any;
    expect(report.verdict).toBe('NEEDS_REVIEW');
  });

  it('LLM enabled → advisory risks added, never flips PASS to FAIL', async () => {
    const ws = makeWs({ 'a.ts': 'export const x = 1;\n' });
    const llmJson = JSON.stringify({
      criteria: [{ criterion: 'better names', passed: false, notes: 'could rename' }],
      risks: [{ level: 'medium', description: 'weak error handling', mitigation: 'add try/catch' }],
      verdict: 'FAIL',
    });
    const router = new FakeModelRouter([{ content: llmJson }]);
    const agent = new AuditAgent(router, { openrouter: 'k' }, undefined, true);
    const manifest = await agent.execute(makeContract(ws, ['a.ts']), ws);
    const report = JSON.parse(manifest.artifacts[0].content) as any;
    // Heuristic says PASS; LLM "FAIL" must NOT override → only NEEDS_REVIEW.
    expect(report.verdict).toBe('NEEDS_REVIEW');
    expect(report.risks.some((r: any) => /weak error handling/.test(r.description))).toBe(true);
    expect(report.criteria.some((c: any) => c.criterion.startsWith('LLM:'))).toBe(true);
  });

  it('LLM fallback (usedFallback) → keep heuristic-only verdict', async () => {
    const ws = makeWs({ 'a.ts': 'export const x = 1;\n' });
    const router = new FakeModelRouter([{ content: 'ignore' }]);
    (router as any).call = async () => ({
      content: 'ignore',
      provider: 'fake',
      model: 'fake',
      usedFallback: true,
      error: 'rate limited',
    });
    const eventBus = new EventBus();
    const commentary: string[] = [];
    eventBus.on('AGENT_COMMENTARY', (event) => commentary.push((event as any).payload.message));
    const agent = new AuditAgent(router, { openrouter: 'k' }, eventBus, true);
    const manifest = await agent.execute(makeContract(ws, ['a.ts']), ws);
    const report = JSON.parse(manifest.artifacts[0].content) as any;
    expect(report.verdict).toBe('PASS');
    expect(report.criteria.every((c: any) => !String(c.criterion).startsWith('LLM:'))).toBe(true);
    expect(commentary.some((message) => message.includes('rate limited'))).toBe(true);
  });
});
