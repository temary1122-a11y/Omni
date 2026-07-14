import { BaseAgent, type LlmReviewRouter } from './BaseAgent';
import type { HandoffContract, ArtifactManifest, SecurityReport } from '../../shared/types';
import type { ConsultFn } from '../core/AgentConsultant';
import type { ModelRouter } from '../routing/ModelRouter';
import type { ResilientModelRouter } from '../core/ResilientModelRouter';
import type { EventBus } from '../core/EventBus';
import * as path from 'path';
import * as fs from 'fs';
import { extractJsonFromLLMResponse } from '../util/llmJson';

const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /password\s*[:=]\s*['"][^'"]+['"]/i,
  /secret\s*[:=]\s*['"][^'"]+['"]/i,
  /sk-[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/,
];

const STATIC_RULES: { pattern: RegExp; severity: SecurityReport['findings'][number]['severity']; issue: string }[] = [
  { pattern: /rejectUnauthorized\s*:\s*false/i, severity: 'high', issue: 'TLS certificate verification disabled (rejectUnauthorized: false)' },
  { pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i, severity: 'high', issue: 'NODE_TLS_REJECT_UNAUTHORIZED disabled globally' },
  { pattern: /\b(ssl|https|tls)\s*:\s*\{[^}]*rejectUnauthorized\s*:\s*false/i, severity: 'high', issue: 'TLS verification disabled in transport config' },
  { pattern: /\beval\s*\(/i, severity: 'medium', issue: 'Use of eval() — dynamic code execution risk' },
  { pattern: /\bnew\s+Function\s*\(/i, severity: 'medium', issue: 'Use of new Function() — dynamic code execution risk' },
  { pattern: /dangerouslyAllowBrowser\s*:\s*true/i, severity: 'medium', issue: 'dangerouslyAllowBrowser: true exposes credentials in browser bundle' },
  { pattern: /\bchild_process\b[\s\S]{0,200}?(\$\{|`|req\.(body|query|params)|\bargv\b)/i, severity: 'medium', issue: 'Possible unsafe shell command built from external/user input' },
];

const MAX_LLM_FILES = 5;
const MAX_FILE_CONTENT_CHARS = 5000;
const MAX_LLM_FINDINGS = 15;
const CONFIDENCE_THRESHOLD = 0.6;

const SECURITY_RELEVANT = /(auth|login|session|token|secret|\.env|password|credential|crypto|security|server|api|route|db|database|config|oauth|jwt|webhook|upload|file)/i;

type LlmSecurityFinding = {
  severity?: string;
  file?: string;
  line?: number;
  issue?: string;
  evidence?: string;
  cwe?: string | null;
  confidence?: number;
};

export class SecurityAgent extends BaseAgent {
  private consultFn?: ConsultFn;
  private router?: ModelRouter | ResilientModelRouter | LlmReviewRouter;
  private apiKeys?: Record<string, string>;
  private enableLlm: boolean;

  constructor(
    router?: ModelRouter | ResilientModelRouter,
    apiKeys?: Record<string, string>,
    eventBus?: EventBus,
    enableLlm = false
  ) {
    super('security', eventBus);
    this.router = router;
    this.apiKeys = apiKeys;
    this.enableLlm = enableLlm;
  }

  setConsultFn(fn: ConsultFn): void {
    this.consultFn = fn;
  }

  async execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest> {
    const regexFindings = runRegexSecrets(contract, workspaceRoot);

    let findings: SecurityReport['findings'] = [...regexFindings];

    if (this.enableLlm && this.router && this.apiKeys) {
      const llm = await safeLlmSecurityReview(contract, workspaceRoot, this.router, this.apiKeys, this.eventBus);
      for (const f of llm.findings) {
        if ((f.confidence ?? 1) >= 0.6 && f.evidence && f.file) {
          findings.push(f);
        }
      }
    }

    const passed = !findings.some(f => f.severity === 'high');
    const report: SecurityReport = {
      taskId: contract.contextPacket.taskId,
      findings,
      passed,
    };

    const content = JSON.stringify(report, null, 2);
    const relPath = `.omniflow/security/${contract.contextPacket.taskId}/security-report.json`;
    const full = path.join(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');

    return this.createManifest(contract.subtaskId, [{ filePath: relPath, content, hash: this.hash(content) }], report.passed ? 'Security PASS' : 'Security issues found');
  }
}

function runRegexSecrets(contract: HandoffContract, workspaceRoot: string): SecurityReport['findings'] {
  const findings: SecurityReport['findings'] = [];

  for (const target of contract.artifactTargets) {
    const full = path.join(workspaceRoot, target.filePath);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            severity: 'high',
            file: target.filePath,
            issue: `Potential secret on line ${idx + 1}: ${line.trim().slice(0, 60)}…`,
          });
        }
      }
      if (/\.env\b/.test(line) && !/\.env\.example/.test(line)) {
        findings.push({ severity: 'low', file: target.filePath, issue: 'References .env file — ensure not committed' });
      }
      for (const rule of STATIC_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ severity: rule.severity, file: target.filePath, issue: `${rule.issue} (line ${idx + 1})` });
        }
      }
    });
  }

  return findings;
}

async function safeLlmSecurityReview(
  contract: HandoffContract,
  workspaceRoot: string,
  router: LlmReviewRouter,
  apiKeys: Record<string, string>,
  eventBus?: EventBus
): Promise<{ findings: SecurityReport['findings'] }> {
  try {
    const files = selectReviewFiles(contract, workspaceRoot);
    if (files.length === 0) {
      return { findings: [] };
    }

    const fileBlock = files
      .map((f) => `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');

    const prompt =
      'You are a security reviewer. Review the listed files for real security issues only: ' +
      'secrets, injection, unsafe shell, auth mistakes, TLS/crypto mistakes, dangerous deserialization. ' +
      'Ignore style, perf, and tests. Respond ONLY with JSON matching this contract:\n' +
      '{"findings":[{"severity":"high|medium|low","file":"relative/path","line":12,"issue":"short description","evidence":"quoted snippet ≤120 chars","cwe":"CWE-798|null","confidence":0.0}],"passed":true}\n' +
      'Only include findings you can justify with a quoted evidence snippet from the file. If none, return {"findings":[],"passed":true}.\n\n' +
      fileBlock;

    const res = await router.call(
      { phase: 'security', agentRole: 'security', complexity: 'low' },
      prompt,
      'You are a security reviewer. Respond ONLY with JSON.',
      apiKeys
    );

    if (!res || res.usedFallback) {
      emitSecurityReviewWarning(
        eventBus,
        `LLM security review unavailable: ${res?.error || 'provider fallback'}`
      );
      return { findings: [] };
    }

    const raw = extractJsonFromLLMResponse(res.content, res.reasoning, '');
    if (!raw) {
      emitSecurityReviewWarning(eventBus, 'LLM security review returned no parseable response');
      return { findings: [] };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      emitSecurityReviewWarning(
        eventBus,
        `LLM security review returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
      return { findings: [] };
    }

    if (!parsed || !Array.isArray(parsed.findings)) {
      emitSecurityReviewWarning(eventBus, 'LLM security review response is missing a findings array');
      return { findings: [] };
    }

    const knownFiles = new Set(files.map((f) => f.rel));
    const llmFindings: SecurityReport['findings'] = [];
    for (const raw of parsed.findings as LlmSecurityFinding[]) {
      if (llmFindings.length >= MAX_LLM_FINDINGS) break;
      const evidence = (raw.evidence || '').toString().trim();
      if (!evidence) continue;
      const confidence = typeof raw.confidence === 'number' ? raw.confidence : 1;
      if (confidence < CONFIDENCE_THRESHOLD) continue;
      const relFile = raw.file && knownFiles.has(raw.file) ? raw.file : undefined;
      if (!relFile) continue;
      const severity = raw.severity === 'high' || raw.severity === 'medium' ? raw.severity : 'low';
      const line = typeof raw.line === 'number' ? ` (line ${raw.line})` : '';
      const cwe = raw.cwe && raw.cwe !== 'null' ? ` [${raw.cwe}]` : '';
      llmFindings.push({
        severity,
        file: relFile,
        issue: `${raw.issue || 'Security concern'}${line} — evidence: "${evidence.slice(0, 120)}"${cwe}`,
        evidence,
        confidence,
      });
    }

    return { findings: llmFindings };
  } catch (error) {
    emitSecurityReviewWarning(
      eventBus,
      `LLM security review failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { findings: [] };
  }
}

function emitSecurityReviewWarning(eventBus: EventBus | undefined, message: string): void {
  eventBus?.emit({
    type: 'AGENT_COMMENTARY',
    payload: {
      agentId: 'security',
      phase: 'security',
      message,
      timestamp: Date.now(),
    },
  });
}

function selectReviewFiles(contract: HandoffContract, workspaceRoot: string): { rel: string; content: string }[] {
  const scored = contract.artifactTargets
    .map((t) => ({ t, full: path.join(workspaceRoot, t.filePath) }))
    .filter((x) => fs.existsSync(x.full))
    .map((x) => {
      const rel = x.t.filePath;
      const score = SECURITY_RELEVANT.test(rel) ? 1 : 0;
      return { rel, score, content: fs.readFileSync(x.full, 'utf-8').slice(0, MAX_FILE_CONTENT_CHARS) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LLM_FILES);
  return scored.map((s) => ({ rel: s.rel, content: s.content }));
}

