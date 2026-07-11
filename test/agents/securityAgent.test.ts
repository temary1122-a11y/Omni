import { describe, expect, it, afterEach } from 'vitest';
import { SecurityAgent } from '../../src/agents/SecurityAgent';
import { FakeModelRouter } from '../fixtures/FakeModelRouter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HandoffContract, ContextPacket } from '../../shared/types';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeWs(files: Record<string, string>): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmp!, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return tmp!;
}

function makeContract(ws: string, files: string[], taskId = 't1'): HandoffContract {
  const contextPacket: ContextPacket = { taskId, goal: 'g', workspaceSnapshot: { fileTree: [] } } as ContextPacket;
  return {
    subtaskId: `sec_${taskId}`,
    agentRole: 'security',
    successCriteria: ['Security complete'],
    artifactTargets: files.map((f) => ({ filePath: f, contentType: 'code' as const })),
    contextPacket,
  };
}

describe('SecurityAgent', () => {
  it('no router → exact heuristic behavior (secrets + static rules)', async () => {
    const ws = makeWs({
      'auth.ts': "const key = 'sk-abcdefghijklmnopqrstuvwx';\nconst x = eval('1+1');\n",
      'app.ts': "const password = \"hunter2\";\n",
    });
    const agent = new SecurityAgent();
    const manifest = await agent.execute(makeContract(ws, ['auth.ts', 'app.ts']), ws);

    const report = JSON.parse(manifest.artifacts[0].content) as any;
    expect(report.passed).toBe(false);
    expect(report.findings.some((f: any) => /sk-/.test(f.issue))).toBe(true);
    expect(report.findings.some((f: any) => /eval\(\)/.test(f.issue))).toBe(true);
    expect(report.findings.some((f: any) => /password/i.test(f.issue))).toBe(true);
  });

  it('LLM enabled → merges LLM findings, keeps regex high, forces passed=false', async () => {
    const ws = makeWs({
      'auth/login.ts': "const token = 'safeValue';\n",
    });
    const llmJson = JSON.stringify({
      findings: [
        { severity: 'high', file: 'auth/login.ts', line: 1, issue: 'Hardcoded token', evidence: "const token = 'safeValue';", cwe: 'CWE-798', confidence: 0.9 },
        { severity: 'high', file: 'auth/login.ts', line: 1, issue: 'Hallucinated, no evidence', confidence: 0.9 },
        { severity: 'medium', file: 'auth/login.ts', issue: 'No evidence', confidence: 0.9 },
        { severity: 'medium', file: 'auth/login.ts', line: 2, issue: 'Low confidence noise', evidence: 'x', confidence: 0.2 },
      ],
      passed: true,
    });
    const router = new FakeModelRouter([{ content: llmJson }]);
    const agent = new SecurityAgent(router, { openrouter: 'k' }, undefined, true);
    const manifest = await agent.execute(makeContract(ws, ['auth/login.ts']), ws);

    const report = JSON.parse(manifest.artifacts[0].content) as any;
    // Only the high-confidence, evidence-backed finding is kept.
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].severity).toBe('high');
    expect(report.findings[0].issue).toContain('Hardcoded token');
    expect(report.passed).toBe(false);
  });

  it('LLM fallback (usedFallback) → ignore LLM, keep heuristics', async () => {
    const ws = makeWs({ 'app.ts': "const password = 'hunter2';\n" });
    const router = new FakeModelRouter([{ content: 'ignore me' }]);
    // Force the FakeModelRouter to report fallback by wrapping call.
    const wrapped = router as any;
    wrapped.call = async () => ({ content: 'ignore', provider: 'fake', model: 'fake', usedFallback: true });

    const agent = new SecurityAgent(router, { openrouter: 'k' }, undefined, true);
    const manifest = await agent.execute(makeContract(ws, ['app.ts']), ws);

    const report = JSON.parse(manifest.artifacts[0].content) as any;
    expect(report.findings.some((f: any) => /password/i.test(f.issue))).toBe(true);
    expect(report.findings.every((f: any) => !f.issue.startsWith('LLM'))).toBe(true);
  });
});
