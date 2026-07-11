// OmniFlow MVP Shared Types
// Used by both extension host and webview

export type Phase = 'intake' | 'planning' | 'build' | 'verify' | 'deliver' | 'self-prompting';

export type AgentStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error';

export type Complexity = 'low' | 'medium' | 'high';

export type IntentType = 'build' | 'research' | 'debug' | 'migrate' | 'refactor';

export type VerificationVerdict = 'PASS' | 'FAIL' | 'NEEDS_REVIEW';

export interface UserGoalPacket {
  taskId: string;
  goal: string;
  intent: IntentType;
  complexity: Complexity;
  workspaceSnapshot: WorkspaceSnapshot;
  clarifications?: Record<string, string>;
}

export interface WorkspaceSnapshot {
  fileTree: string[];
  hasPackageJson: boolean;
  hasReadme: boolean;
  techStack: string[];
}

export interface ExecutionPlan {
  planId: string;
  subtasks: SubTask[];
  estimatedDuration: number;
  totalSubtasks: number;
}

export interface SubTask {
  subtaskId: string;
  agentRole: AgentRoleId;
  description: string;
  successCriteria: string[];
  artifactTargets: ArtifactTarget[];
}

export type AgentRoleId = 'clarifier' | 'builder' | 'verifier' | 'orchestrator';

export type AgentRole = AgentRoleId;

export interface ArtifactTarget {
  filePath: string;
  contentType: 'code' | 'config' | 'documentation';
}

export interface HandoffContract {
  subtaskId: string;
  agentRole: AgentRoleId;
  successCriteria: string[];
  artifactTargets: ArtifactTarget[];
  contextPacket: ContextPacket;
}

export interface ContextPacket {
  taskId: string;
  goal: string;
  workspaceSnapshot: WorkspaceSnapshot;
  researchSummary?: string;
  planSummary?: string;
  memoryContext?: string;
}

export interface ArtifactManifest {
  artifacts: FileArtifact[];
  subtaskId: string;
  completedAt: number;
  selfVerification: string;
}

export interface FileArtifact {
  filePath: string;
  content: string;
  hash: string;
}

export interface VerificationVerdictReport {
  verdict: VerificationVerdict;
  subtaskId: string;
  criteria: CriteriaResult[];
  risks: Risk[];
  remediationHints?: string[];
}

export interface CriteriaResult {
  criterion: string;
  passed: boolean;
  notes?: string;
}

export interface Risk {
  level: 'low' | 'medium' | 'high';
  description: string;
  mitigation?: string;
}

export interface DeliveryReport {
  taskId: string;
  artifacts: ArtifactRef[];
  verdict: VerificationVerdict;
  durationMs: number;
  ledgerPath: string;
}

export interface ArtifactRef {
  filePath: string;
  opened: boolean;
}

export interface DegradedModeReport {
  ok: boolean;
  reason: string;
  fallbackUsed: string;
  userMessage: string;
}

export interface AgentReasoning {
  agentId: AgentRole;
  phase: Phase;
  thought: string;
  timestamp: number;
}

// IPC Message Types
export type IpcMessage =
  | { type: 'OMNIFLOW_STATE_UPDATE'; payload: OrchestratorState }
  | { type: 'PHASE_TRANSITION'; payload: PhaseTransitionEvent }
  | { type: 'AGENT_STATUS_UPDATE'; payload: AgentStatusUpdate }
  | { type: 'ARTIFACT_CREATED'; payload: ArtifactCreatedEvent }
  | { type: 'VERIFICATION_RESULT'; payload: VerificationResultEvent }
  | { type: 'DELIVERY_COMPLETE'; payload: DeliveryCompleteEvent }
  | { type: 'ERROR_OCCURRED'; payload: ErrorEvent }
  | { type: 'SANDBOX_EVENT'; payload: import('./sandbox').SandboxEvent }
  | { type: 'REASONING_TRACE'; payload: AgentReasoning }
  | { type: 'SYMBOL_RESOLVED'; payload: SymbolResolveResult & { agentId: string } }
  | { type: 'SEMANTIC_EDIT_APPLIED'; payload: SemanticEditResult }
  | { type: 'TOOL_CALL'; payload: import('./../types').ToolCallEvent }
  | { type: 'TOOL_RESULT'; payload: import('./../types').ToolResultEvent }
  | { type: 'INDEX_LOADED'; payload: { count: number } }
  | { type: 'INDEX_UPDATED'; payload: { providers: string[] } };


export interface OrchestratorState {
  currentPhase: Phase;
  taskId?: string;
  goal?: string;
  completedPhases: Phase[];
  activeAgent?: AgentRoleId;
  agentStatus: Record<AgentRoleId, AgentStatus>;
  artifacts: ArtifactRef[];
  verificationVerdict?: VerificationVerdict;
  ledgerEntries: LedgerEntry[];
}

export interface PhaseTransitionEvent {
  from: Phase | null;
  to: Phase;
  timestamp: number;
}

export interface AgentStatusUpdate {
  agentId: AgentRoleId;
  status: AgentStatus;
  taskId?: string;
  message?: string;
}

export interface ArtifactCreatedEvent {
  filePath: string;
  agentId: AgentRoleId;
  taskId: string;
}

export interface VerificationResultEvent {
  subtaskId: string;
  verdict: VerificationVerdict;
  risks: Risk[];
}

export interface DeliveryCompleteEvent {
  taskId: string;
  report: DeliveryReport;
}

export interface ErrorEvent {
  error: string;
  phase: Phase;
  recoverable: boolean;
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
  location?: SymbolLocation;
  reason?: string;
}

export interface SemanticEditInput {
  file: string;
  symbolName: string;
  newCode: string;
  action?: 'replace_symbol';
}

export interface SemanticEditResult {
  success: boolean;
  file: string;
  symbolName: string;
  oldRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  error?: string;
}

export interface LedgerEntry {
  timestamp: number;
  type: 'phase_transition' | 'artifact_created' | 'verification' | 'error' | 'delivery' | 'sandbox_event' | 'reasoning' | 'symbol_resolved' | 'semantic_edit';
  data: Record<string, any>;
}

export const PHASE_ORDER: Phase[] = ['intake', 'planning', 'build', 'verify', 'deliver'];

export type { SandboxEvent, SandboxCommandOptions, SandboxCommandResult, SandboxConfig } from './sandbox';


