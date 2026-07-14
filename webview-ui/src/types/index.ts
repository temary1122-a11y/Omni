// ============================================================
// Omni Extension — canonical TypeScript contract for the React webview UI
// Mirrors the authoritative backend IPC contract in shared/types.ts.
// Contains ONLY type/interface declarations. No runtime code.
// ============================================================

// ─── Domain Types ───────────────────────────────────────────

export type Phase =
  | 'idle'
  | 'intake'
  | 'research'
  | 'planning'
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
  callId?: string;
}

export interface ToolResultEvent {
  agentId: AgentRole;
  toolName: string;
  success: boolean;
  output?: string;
  error?: string;
  timestamp: number;
  callId?: string;
}

export interface AgentStatusUpdate {
  agentId: AgentRole;
  status: AgentStatus;
  message?: string;
  progress?: number;
}

export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  feedback?: string;
}

export type VerificationVerdict = 'PASS' | 'FAIL' | 'NEEDS_REVIEW';

export interface DeliveryReport {
  taskId: string;
  artifacts: { filePath: string; opened: boolean }[];
  verdict: VerificationVerdict;
  durationMs: number;
  ledgerPath: string;
  runInstructions: string;
  summary: string;
}

export interface AgentConsultPayload {
  from: string;
  to: AgentRole;
  question: string;
  answer?: string;
}

export interface ApiKeyPromptPayload {
  requestId: string;
  tools: { toolName: string; envVar: string; signupUrl: string }[];
  fallbackAvailable: boolean;
  reason: string;
}

export interface ProviderStatusPayload {
  provider: string;
  hasKey: boolean;
  budget: string;
  preferredProvider?: string;
}

export interface ModelCatalogPayload {
  providers: Record<string, string[]>;
}

export interface LlmCallPayload {
  provider: string;
  model: string;
  agentRole: AgentRole;
  phase: Phase;
  usedFallback: boolean;
  error?: string;
  endpoint?: string;
}

export interface ArtifactCreatedPayload {
  filePath: string;
  agentId: string;
  taskId: string;
}

export interface CommandOutputPayload {
  command: string;
  output: string;
  exitCode: number | null;
}

export interface OmniState {
  currentPhase: Phase;
  completedPhases: Phase[];
  agents: Record<string, AgentStatus>;
  artifacts: string[];
  isRunning: boolean;
}

export interface SymbolResolveResult {
  found: boolean;
  symbolName: string;
  location?: {
    uri: string;
    range: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
    containerName?: string;
    kind?: string;
  };
  reason?: string;
}

export interface SemanticEditResult {
  success: boolean;
  file: string;
  symbolName: string;
  oldRange?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  error?: string;
  symbolFound?: boolean;
  symbolLocation?: {
    uri: string;
    range: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
    containerName?: string;
    kind?: string;
  };
}

export interface ApprovalRequiredPayload {
  requestId: string;
  title: string;
  tier: string;
  architecture: string;
  stack: string[];
  acceptanceCriteria: string[];
  files: string[];
  summary: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WorkspaceFile[];
}

// ─── BackendEvent (Backend → UI) ────────────────────────────

export type BackendEvent =
  | { type: 'OMNIFLOW_STATE_UPDATE'; payload: OmniState }
  | { type: 'PHASE_TRANSITION'; payload: { from: Phase; to: Phase; timestamp: number } }
  | { type: 'AGENT_STATUS_UPDATE'; payload: AgentStatusUpdate }
  | { type: 'ARTIFACT_CREATED'; payload: ArtifactCreatedPayload }
  | { type: 'VERIFICATION_RESULT'; payload: { subtaskId: string; verdict: VerificationVerdict; risks: unknown[] } }
  | { type: 'DELIVERY_COMPLETE'; payload: { taskId: string; report: DeliveryReport } }
  | { type: 'CLARIFYING_QUESTIONS'; payload: { taskId: string; questions: ClarifyingQuestion[] } }
  | { type: 'CHAT_MESSAGE'; payload: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: number } }
  | { type: 'COMMAND_OUTPUT'; payload: CommandOutputPayload }
  | { type: 'LLM_CALL'; payload: LlmCallPayload }
  | { type: 'PROVIDER_STATUS'; payload: ProviderStatusPayload }
  | { type: 'ERROR_OCCURRED'; payload: { error: string; phase: Phase; recoverable: boolean } }
  | { type: 'SANDBOX_EVENT'; payload: { type: string; data?: Record<string, unknown> } }
  | { type: 'REASONING_TRACE'; payload: AgentReasoning }
  | { type: 'AGENT_COMMENTARY'; payload: AgentCommentary }
  | { type: 'TOOL_CALL'; payload: ToolCallEvent }
  | { type: 'TOOL_RESULT'; payload: ToolResultEvent }
  | { type: 'SYMBOL_RESOLVED'; payload: SymbolResolveResult & { agentId: AgentRole; timestamp: number } }
  | { type: 'SEMANTIC_EDIT_APPLIED'; payload: SemanticEditResult & { timestamp: number } }
  | { type: 'AGENT_CONSULT'; payload: AgentConsultPayload }
  | { type: 'VERIFY_BOUNCE'; payload: { attempt: number; failedCriteria: string[]; feedback: string } }
  | { type: 'APPROVAL_REQUIRED'; payload: ApprovalRequiredPayload }
  | { type: 'APPROVAL_RESPONSE'; payload: ApprovalResponse }
  | { type: 'INDEX_LOADED'; payload: { count: number } }
  | { type: 'API_KEY_PROMPT'; payload: ApiKeyPromptPayload }
  | { type: 'INDEX_UPDATED'; payload: { providers: string[] } }
  | { type: 'MODEL_CATALOG'; payload: ModelCatalogPayload }
  | { type: 'WORKSPACE_TREE'; payload: { root: string; tree: WorkspaceFile[] } }
  | { type: 'BACKEND_READY'; payload: { version: string } };

// ─── UiCommand (UI → Backend) ───────────────────────────────

export type UiCommand =
  | { command: 'start'; goal: string; mode?: 'chat' | 'code' | 'ask' }
  | { command: 'continueChat'; goal: string }
  | { command: 'submitAnswers'; answers: ClarifyingAnswer[] }
  | { command: 'submitApproval'; requestId: string; approved: boolean; feedback?: string }
  | { command: 'openArtifact'; filePath: string }
  | { command: 'configureApi' }
  | { command: 'selectModel' }
  | { command: 'stopGeneration' }
  | { command: 'pauseSession' }
  | { command: 'continueSession' }
  | { command: 'clearChat' }
  | { command: 'exportSession' }
  | { command: 'switchAgent'; agentId: AgentRole }
  | { command: 'openExternal'; url: string }
  | { command: 'submitApiKeyPrompt'; requestId: string; action: 'proceed' | 'skip' | 'fallback'; keys?: Record<string, string> }
  | { command: 'requestWorkspace' }
  | { command: 'updateSettings'; chatVerbosity?: 'minimal' | 'normal' | 'debug'; useSupervisor?: boolean; budget?: 'free' | 'low' | 'normal' | 'high' }
  | { command: 'loadSession'; sessionId: string }
  | { command: 'deleteSession'; sessionId: string };

// ─── UI Message Model ───────────────────────────────────────

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string; agentId: AgentRole; phase: Phase }
  | { type: 'tool_call'; toolName: string; args?: Record<string, unknown>; agentId?: AgentRole; callId?: string; success?: boolean; output?: string; error?: string; status?: 'running' | 'success' | 'error' }
  | { type: 'code'; language: string; code: string }
  | { type: 'file_diff'; filePath: string; diff: string }
  | { type: 'agent_consult'; from: string; to: AgentRole; question: string; answer?: string }
  | { type: 'commentary'; agentId: AgentRole; phase: Phase; message: string }
  | { type: 'approval_required'; requestId: string; title: string; tier: string; architecture?: string; stack?: string[]; acceptanceCriteria: string[]; files: string[]; summary: string }
  | { type: 'clarifying_questions'; taskId: string; questions: ClarifyingQuestion[] }
  | { type: 'artifact'; filePath: string; agentId?: string }
  | { type: 'delivery'; report: DeliveryReport }
  | { type: 'phase'; from: Phase; to: Phase };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: number;
  parts: MessagePart[];
  agentId?: AgentRole;
  phase?: Phase;
}

// ─── Re-exports for convenience ─────────────────────────────
// (All of the above are already exported as named declarations; re-exporting
//  them here would create duplicate-export conflicts, so this block is omitted.)
