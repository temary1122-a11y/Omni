import type {
  AgentRole,
  AgentStatus,
  Phase,
  Message,
  ClarifyingQuestion,
  ClarifyingAnswer,
  ApprovalRequiredPayload,
  ApiKeyPromptPayload,
  WorkspaceFile,
} from '@/types';
import type { ChatVerbosity } from '@/lib/chatFilters';
import { CANONICAL_AGENT_ROLES } from '@/utils/agentConfig';

export interface OmniState {
  sessionId: string;
  goal: string;
  mode: 'chat' | 'code' | 'ask';
  isStreaming: boolean;
  isRunning: boolean;
  isPaused: boolean;
  currentPhase: Phase;
  completedPhases: Phase[];
  messages: Message[];
  agentStatuses: Record<AgentRole, AgentStatus>;
  reasoningTraces: Record<AgentRole, string[]>;
  activeTab: 'chat' | 'files' | 'sessions' | 'settings';
  sidebarOpen: boolean;
  pendingQuestions: ClarifyingQuestion[] | null;
  pendingApproval: ApprovalRequiredPayload | null;
  pendingApiKeyPrompt: ApiKeyPromptPayload | null;
  artifacts: string[];
  providerInfo: Record<string, { hasKey: boolean; budget: string }>;
  preferredProvider: string;
  lastError: { error: string; phase?: Phase; recoverable: boolean } | null;
  modelCatalog: Record<string, string[]>;
  workspaceTree: WorkspaceFile[];
  workspaceRoot: string;
  scrollTargetPhase: Phase | null;
  chatVerbosity: ChatVerbosity;
  useSupervisor: boolean;
  budget: 'free' | 'low' | 'normal' | 'high';
  activityLog: string[];
  demoMode: boolean;
  recentSessions: Array<{ id: string; goal: string; timestamp: number; messageCount: number }>;
}

export interface OmniActions {
  handleBackendEvent(event: import('@/types').BackendEvent): void;
  sendCommand(command: import('@/types').UiCommand['command'], payload?: Record<string, unknown>): void;
  startNewSession(goal: string, mode?: 'chat' | 'code' | 'ask'): void;
  continueChat(goal: string): void;
  setActiveTab(tab: OmniState['activeTab']): void;
  setSidebarOpen(open: boolean): void;
  setStreaming(streaming: boolean): void;
  clearMessages(): void;
  dismissError(): void;
  selectModel(model?: string): void;
  configureApi(): void;
  openArtifact(filePath: string): void;
  openExternal(url: string): void;
  submitAnswers(answers: ClarifyingAnswer[]): void;
  submitApproval(requestId: string, approved: boolean, feedback?: string): void;
  submitApiKeyPrompt(requestId: string, action: 'proceed' | 'skip' | 'fallback', keys?: Record<string, string>): void;
  togglePause(): void;
  stopGeneration(): void;
  continueSession(): void;
  exportSession(): void;
  switchAgent(agentId: AgentRole): void;
  requestWorkspace(): void;
  resetSession(): void;
  clearScrollTarget(): void;
  setChatVerbosity(v: ChatVerbosity): void;
  setUseSupervisor(enabled: boolean): void;
  setBudget(budget: OmniState['budget']): void;
  setPreferredProvider(provider: string): void;
  setDemoMode(enabled: boolean): void;
  updateSettings(settings: {
    chatVerbosity?: ChatVerbosity;
    useSupervisor?: boolean;
    budget?: OmniState['budget'];
    preferredProvider?: string;
  }): void;
  loadSession(sessionId: string): void;
  deleteSession(sessionId: string): void;
}

export function idleStatuses(): Record<AgentRole, AgentStatus> {
  const out = {} as Record<AgentRole, AgentStatus>;
  for (const r of CANONICAL_AGENT_ROLES) out[r] = 'idle';
  return out;
}

export function emptyTraces(): Record<AgentRole, string[]> {
  const out = {} as Record<AgentRole, string[]>;
  for (const r of CANONICAL_AGENT_ROLES) out[r] = [];
  return out;
}

export const initialOmniState: OmniState = {
  sessionId: '',
  goal: '',
  mode: 'code',
  isStreaming: false,
  isRunning: false,
  isPaused: false,
  currentPhase: 'idle' as Phase,
  completedPhases: [],
  messages: [],
  agentStatuses: idleStatuses(),
  reasoningTraces: emptyTraces(),
  activeTab: 'chat',
  sidebarOpen: false,
  pendingQuestions: null,
  pendingApproval: null,
  pendingApiKeyPrompt: null,
  artifacts: [],
  providerInfo: {},
  preferredProvider: 'openrouter',
  lastError: null,
  modelCatalog: {},
  workspaceTree: [],
  workspaceRoot: '',
  scrollTargetPhase: null,
  chatVerbosity: 'minimal',
  useSupervisor: false,
  budget: 'free',
  activityLog: [],
  demoMode: false,
  recentSessions: [],
};
