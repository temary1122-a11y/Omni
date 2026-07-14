// Omni shared types — extension + webview IPC contracts

export type Phase =
  | 'intake'
  | 'research'
  | 'planning'
  | 'self-prompt'
  | 'context-enrich'
  | 'build'
  | 'audit'
  | 'security'
  | 'verify'
  | 'deliver'
  | 'consult';

export type Complexity = 'low' | 'medium' | 'high';
export type IntentType = 'build' | 'research' | 'debug' | 'migrate' | 'refactor';
export type AgentRole =
  | 'orchestrator'
  | 'clarifier'
  | 'researcher'
  | 'planner'
  | 'coder'
  | 'auditor'
  | 'security'
  | 'verifier'
  | 'pre-installer'
  | 'tool-manager'
  | 'context-agent';

export type AgentStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error';

export interface ClarifyingQuestion {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  context?: string;
}

export interface ClarifyingAnswer {
  questionId: string;
  selectedOption?: string;
  customText?: string;
}

export interface WorkspaceSnapshot {
  fileTree: string[];
  hasPackageJson: boolean;
  hasReadme: boolean;
  techStack: string[];
}

export interface UserGoalPacket {
  taskId: string;
  goal: string;
  intent: IntentType;
  complexity: Complexity;
  workspaceSnapshot: WorkspaceSnapshot;
  clarifications?: ClarifyingAnswer[];
  refinedGoal?: string;
}

export interface ResearchReport {
  taskId: string;
  summary: string;
  terms: string[];
  bestPractices: string[];
  patterns: string[];
  sources: string[];
}

export interface ExecutionPlan {
  planId: string;
  stack: string[];
  architecture: string;
  subtasks: HandoffContract[];
  estimatedDuration: number;
  totalSubtasks: number;
}

export interface ContextPacket {
  taskId: string;
  goal: string;
  workspaceSnapshot: WorkspaceSnapshot;
  planSummary?: string;
  researchSummary?: string;
  researchReport?: ResearchReport;
  bounceContext?: { feedback: string; failedCriteria: string[]; previousArtifactPaths: string[] };
  /** Project convention docs (AGENTS.md) and memory (OMNI.md), when present. Injected so agents rely on them. */
  agentsMd?: string;
  omniMd?: string;
  /** Stack chosen by the Planner for THIS task. Authoritative for the coder — overrides workspaceSnapshot.techStack. */
  plannedStack?: string[];
  /** Memory enrichment block attached by ContextEnrichPhase. */
  memoryContext?: string;
}

export interface ArtifactTarget {
  filePath: string;
  contentType: 'code' | 'config' | 'doc' | 'test';
}

export interface HandoffContract {
  subtaskId: string;
  agentRole: AgentRole;
  description?: string;
  successCriteria: string[];
  artifactTargets: ArtifactTarget[];
  contextPacket: ContextPacket;
  dependsOn?: string[];
  compassPath?: string;
  /**
   * Explicit WRITE-boundary: the list of relative file/dir paths this agent is
   * allowed to WRITE. Reads are never restricted. When omitted the agent may
   * write anywhere (legacy behavior). Used to run parallel agents without
   * cross-interference — two agents whose boundaries overlap are never scheduled
   * in the same parallel batch, and any out-of-boundary write is rejected.
   */
  boundary?: string[];
}

export interface FileArtifact {
  filePath: string;
  content: string;
  hash: string;
}

export interface ArtifactManifest {
  artifacts: FileArtifact[];
  subtaskId: string;
  completedAt: number;
  selfVerification: string;
}

export type VerificationVerdict = 'PASS' | 'FAIL' | 'NEEDS_REVIEW';

export interface VerificationVerdictReport {
  verdict: VerificationVerdict;
  subtaskId: string;
  criteria: { criterion: string; passed: boolean; notes?: string }[];
  risks: { level: 'low' | 'medium' | 'high'; description: string; mitigation?: string }[];
  remediationHints?: string[];
  decision?: 'ACCEPT' | 'REJECT' | 'ESCALATE';
  failedCriteria?: string[];
  feedback?: string;
  /** Result of actually executing the project's test/build suite, when detectable. */
  testReport?: { command: string; ran: boolean; passed: boolean; output: string };
}

export interface SecurityReport {
  taskId: string;
  findings: {
    severity: 'low' | 'medium' | 'high';
    file: string;
    issue: string;
    evidence?: string;
    cwe?: string | null;
    confidence?: number;
  }[];
  passed: boolean;
}

export interface DeliveryReport {
  taskId: string;
  artifacts: { filePath: string; opened: boolean }[];
  verdict: VerificationVerdict;
  durationMs: number;
  ledgerPath: string;
  runInstructions: string;
  summary: string;
}

export interface AgentReasoning {
  agentId: AgentRole;
  phase: Phase;
  thought: string;
  timestamp: number;
}

export interface AgentCommentary {
  agentId: AgentRole;
  phase: Phase;
  message: string;
  timestamp: number;
}

export interface ToolCallEvent {
  agentId: AgentRole;
  toolName: string;
  args?: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultEvent {
  agentId: AgentRole;
  toolName: string;
  success: boolean;
  output?: string;
  error?: string;
  timestamp: number;
}

export interface AgentStatusUpdate {
  agentId: AgentRole;
  status: AgentStatus;
  message?: string;
  progress?: number;
}

export interface AgentGraphEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
}

export interface SymbolLocation {
  uri: string;
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  containerName?: string;
  kind?: string;
}

export interface SymbolResolveResult {
  found: boolean;
  symbolName: string;
  location?: SymbolLocation;
  reason?: string;
}

export interface SemanticEditInput {
  action: 'replace_symbol';
  file: string;
  symbolName: string;
  newCode: string;
}

export interface SemanticEditResult {
  success: boolean;
  file: string;
  symbolName: string;
  oldRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  error?: string;
  symbolFound?: boolean;
  symbolLocation?: {
    uri: string;
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    containerName?: string;
    kind?: string;
  };
}

export interface LedgerEntry {
  timestamp: number;
  type: 'phase_transition' | 'artifact_created' | 'verification' | 'delivery' | 'error' | 'agent_status' | 'reasoning' | 'sandbox_event' | 'symbol_resolved' | 'semantic_edit';
  data: Record<string, unknown>;
}

export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  feedback?: string;
}

export type IpcMessage =
  | { type: 'OMNIFLOW_STATE_UPDATE'; payload: OmniState }
  | { type: 'PHASE_TRANSITION'; payload: { from: Phase; to: Phase; timestamp: number } }
  | { type: 'AGENT_STATUS_UPDATE'; payload: AgentStatusUpdate }
  | { type: 'ARTIFACT_CREATED'; payload: { filePath: string; agentId: string; taskId: string } }
  | { type: 'VERIFICATION_RESULT'; payload: { subtaskId: string; verdict: VerificationVerdict; risks: unknown[] } }
  | { type: 'DELIVERY_COMPLETE'; payload: { taskId: string; report: DeliveryReport } }
  | { type: 'CLARIFYING_QUESTIONS'; payload: { taskId: string; questions: ClarifyingQuestion[] } }
  | { type: 'CHAT_MESSAGE'; payload: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: number } }
  | { type: 'COMMAND_OUTPUT'; payload: { command: string; output: string; exitCode: number | null } }
  | { type: 'LLM_CALL'; payload: { provider: string; model: string; agentRole: AgentRole; phase: Phase; usedFallback: boolean; error?: string; endpoint?: string } }
  | { type: 'PROVIDER_STATUS'; payload: { provider: string; hasKey: boolean; budget: string; preferredProvider?: string } }
  | { type: 'ERROR_OCCURRED'; payload: { error: string; phase: Phase; recoverable: boolean } }
  | { type: 'SANDBOX_EVENT'; payload: { type: string; data?: Record<string, unknown> } }
  | { type: 'REASONING_TRACE'; payload: AgentReasoning }
  | { type: 'AGENT_COMMENTARY'; payload: AgentCommentary }
  | { type: 'TOOL_CALL'; payload: ToolCallEvent }
  | { type: 'TOOL_RESULT'; payload: ToolResultEvent }
  | { type: 'SYMBOL_RESOLVED'; payload: SymbolResolveResult & { agentId: AgentRole; timestamp: number } }
  | { type: 'SEMANTIC_EDIT_APPLIED'; payload: SemanticEditResult & { timestamp: number } }
  | { type: 'AGENT_CONSULT'; payload: { from: string; to: AgentRole; question: string; answer?: string } }
  | { type: 'VERIFY_BOUNCE'; payload: { attempt: number; failedCriteria: string[]; feedback: string } }
  | { type: 'APPROVAL_REQUIRED'; payload: { requestId: string; title: string; tier: string; architecture: string; stack: string[]; acceptanceCriteria: string[]; files: string[]; summary: string } }
  | { type: 'APPROVAL_RESPONSE'; payload: ApprovalResponse }
  | { type: 'INDEX_LOADED'; payload: { count: number } }
  | { type: 'API_KEY_PROMPT'; payload: { requestId: string; tools: { toolName: string; envVar: string; signupUrl: string }[]; fallbackAvailable: boolean; reason: string } }
  | { type: 'INDEX_UPDATED'; payload: { providers: string[] } }
  | { type: 'MODEL_CATALOG'; payload: { providers: Record<string, string[]> } }
  | { type: 'WORKSPACE_TREE'; payload: { root: string; tree: WorkspaceFile[] } }
  | { type: 'BACKEND_READY'; payload: { version: string } };

export interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WorkspaceFile[];
}

export interface OmniState {
  currentPhase: Phase;
  completedPhases: Phase[];
  agents: Record<string, AgentStatus>;
  artifacts: string[];
  isRunning: boolean;
  isStreaming: boolean;
}
