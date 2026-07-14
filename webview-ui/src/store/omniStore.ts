import { create } from 'zustand';
import type { BackendEvent, UiCommand, AgentRole, AgentStatus, ClarifyingAnswer, Message } from '@/types';
import { type OmniState, type OmniActions, idleStatuses, emptyTraces, initialOmniState } from './storeTypes';
import { postCommand, isBackendConnected } from '@/lib/vscode';
import { simulateDemoFlow } from '@/sim/engine';
import {
  shouldShowCommentary,
  shouldShowLlmCall,
  shouldShowReasoningInChat,
  shouldShowToolInChat,
  isSystemReportWrite,
  type ChatVerbosity,
} from '@/lib/chatFilters';
import { appendPart, callIndex, uid } from './storeUtils';
import { createPipelineSlice } from './slices/pipelineSlice';
import { createUiSlice } from './slices/uiSlice';

export const useOmniStore = create<OmniState & OmniActions>((set, get, api) => {
  const pipelineSlice = createPipelineSlice(set, get, api);
  const uiSlice = createUiSlice(set, get, api);

  const actions: OmniActions = {
    handleBackendEvent(event: BackendEvent): void {
      const { type, payload } = event;
      const verbosity = get().chatVerbosity;
      const logActivity = (line: string) => {
        if (verbosity !== 'debug') return;
        set((s) => ({ activityLog: [...s.activityLog.slice(-80), line] }));
      };

      switch (type) {
        case 'OMNIFLOW_STATE_UPDATE':
          set({
            currentPhase: payload.currentPhase,
            completedPhases: payload.completedPhases,
            agentStatuses: payload.agents as Record<AgentRole, AgentStatus>,
            artifacts: payload.artifacts,
            isRunning: payload.isRunning,
            isStreaming: (payload as { isStreaming?: boolean }).isStreaming ?? get().isStreaming,
            isPaused: payload.isRunning ? get().isPaused : false,
          });
          break;

        case 'PHASE_TRANSITION':
          set((s) => ({
            currentPhase: payload.to,
            completedPhases: s.completedPhases.includes(payload.from)
              ? s.completedPhases
              : [...s.completedPhases, payload.from],
            messages: appendPart(s.messages, {
              type: 'phase',
              from: payload.from,
              to: payload.to,
            }),
          }));
          break;

        case 'AGENT_STATUS_UPDATE':
          set((s) => ({
            agentStatuses: { ...s.agentStatuses, [payload.agentId]: payload.status },
          }));
          break;

        case 'ARTIFACT_CREATED':
          set((s) => ({
            artifacts: s.artifacts.includes(payload.filePath)
              ? s.artifacts
              : [...s.artifacts, payload.filePath],
            messages: appendPart(s.messages, {
              type: 'artifact',
              filePath: payload.filePath,
              agentId: payload.agentId,
            }),
          }));
          break;

        case 'VERIFICATION_RESULT': {
          const verdict = payload.verdict;
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: 'verifier',
              phase: 'verify',
              message: `Verification verdict: ${verdict}`,
            }),
          }));
          break;
        }

        case 'DELIVERY_COMPLETE':
          set((s) => ({
            isRunning: false,
            isStreaming: false,
            isPaused: false,
            messages: appendPart(s.messages, {
              type: 'delivery',
              report: payload.report,
            }),
          }));
          break;

        case 'LLM_CALL':
          logActivity(`LLM ${payload.provider}/${payload.model}${payload.usedFallback ? ' (fallback)' : ''}`);
          if (!shouldShowLlmCall(verbosity)) break;
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: payload.agentRole,
              phase: payload.phase,
              message: `LLM · ${payload.provider}/${payload.model}${payload.usedFallback ? ' · fallback' : ''}`,
            }),
          }));
          break;

        case 'PROVIDER_STATUS':
          set((s) => ({
            providerInfo: {
              ...s.providerInfo,
              [payload.provider]: { hasKey: payload.hasKey, budget: payload.budget },
            },
            preferredProvider: payload.preferredProvider ?? s.preferredProvider,
          }));
          break;

        case 'MODEL_CATALOG':
          set({ modelCatalog: payload.providers });
          break;

        case 'ERROR_OCCURRED':
          set((s) => ({
            lastError: {
              error: payload.error,
              phase: payload.phase,
              recoverable: payload.recoverable,
            },
            isRunning: false,
            isStreaming: false,
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: 'orchestrator',
              phase: payload.phase,
              message: `Error: ${payload.error}`,
            }),
          }));
          break;

        case 'SANDBOX_EVENT':
          break;

        case 'REASONING_TRACE': {
          const aid = payload.agentId as AgentRole;
          set((s) => ({
            reasoningTraces: {
              ...s.reasoningTraces,
              [aid]: [...(s.reasoningTraces[aid] ?? []), payload.thought],
            },
            isStreaming: true,
            ...(shouldShowReasoningInChat(verbosity)
              ? {
                  messages: appendPart(s.messages, {
                    type: 'reasoning',
                    content: payload.thought,
                    agentId: aid,
                    phase: payload.phase,
                  }),
                }
              : {}),
          }));
          break;
        }

        case 'AGENT_COMMENTARY':
          if (!shouldShowCommentary(verbosity, payload.message, payload.agentId)) {
            logActivity(`[${payload.agentId}] ${payload.message}`);
            break;
          }
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: payload.agentId,
              phase: payload.phase,
              message: payload.message,
            }),
          }));
          break;

        case 'TOOL_CALL': {
          if (!shouldShowToolInChat(verbosity, payload.toolName)) {
            logActivity(`tool ${payload.toolName}`);
            break;
          }
          // System function: the researcher's report file is written for Omni
          // internals and must not appear in the user's chat.
          if (isSystemReportWrite(payload.toolName, payload.args)) {
            logActivity(`tool ${payload.toolName} (system report)`);
            break;
          }
          set((s) => {
            const messages = appendPart(s.messages, {
              type: 'tool_call',
              toolName: payload.toolName,
              args: payload.args,
              agentId: payload.agentId,
              callId: payload.callId ?? payload.timestamp.toString(),
            });
            callIndex.set(payload.callId ?? payload.timestamp.toString(), messages.length - 1);
            return { messages };
          });
          break;
        }

        case 'TOOL_RESULT': {
          const callId = payload.callId ?? payload.timestamp.toString();
          const msgIdx = callIndex.get(callId);
          if (msgIdx === undefined) break;
          set((s) => {
            const next = s.messages.slice();
            if (!next[msgIdx]) return {};
            const msg = next[msgIdx];
            // Find the tool_call part and update it with result
            const toolCallPartIndex = msg.parts.findIndex(
              (p) => p.type === 'tool_call' && (p as any).callId === callId
            );
            if (toolCallPartIndex === -1) return {};
            next[msgIdx] = {
              ...msg,
              parts: msg.parts.map((p, i) =>
                i === toolCallPartIndex
                  ? {
                      ...p,
                      type: 'tool_call' as const,
                      success: payload.success,
                      output: payload.output,
                      error: payload.error,
                      status: payload.success ? 'success' : 'error',
                    }
                  : p
              ),
            };
            return { messages: next };
          });
          break;
        }

        case 'SYMBOL_RESOLVED':
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: payload.agentId,
              phase: 'research',
              message: `Resolved ${payload.symbolName}: ${payload.found ? 'found' : payload.reason ?? 'not found'}`,
            }),
          }));
          break;

        case 'SEMANTIC_EDIT_APPLIED':
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: 'coder',
              phase: 'build',
              message: `Semantic edit on ${payload.file} (${payload.symbolName}): ${
                payload.success ? 'applied' : payload.error ?? 'failed'
              }`,
            }),
          }));
          break;

        case 'AGENT_CONSULT':
          set((s) => ({
            messages: appendPart(s.messages, {
              type: 'agent_consult',
              from: payload.from,
              to: payload.to,
              question: payload.question,
              answer: payload.answer,
            }),
          }));
          break;

        case 'VERIFY_BOUNCE':
          set((s) => ({
            lastError: {
              error: `Verify bounce (attempt ${payload.attempt}): ${payload.feedback}`,
              recoverable: true,
            },
            messages: appendPart(s.messages, {
              type: 'commentary',
              agentId: 'verifier',
              phase: 'verify',
              message: `Verify bounce: ${payload.feedback}`,
            }),
          }));
          break;

        case 'APPROVAL_REQUIRED':
          set({ pendingApproval: payload });
          break;

        case 'APPROVAL_RESPONSE':
          set({ pendingApproval: null });
          break;

        case 'API_KEY_PROMPT':
          set({ pendingApiKeyPrompt: payload });
          break;

        case 'CHAT_MESSAGE': {
          if (payload.role === 'system') break;
          const msg: Message = {
            id: uid('msg'),
            role: payload.role,
            timestamp: payload.timestamp,
            parts: [{ type: 'text', content: payload.content }],
          };
          set((s) => ({
            messages: [...s.messages, msg],
            recentSessions: s.recentSessions.map((sess) =>
              sess.id === s.sessionId ? { ...sess, messageCount: sess.messageCount + 1 } : sess
            ),
          }));
          break;
        }

        case 'WORKSPACE_TREE':
          set({ workspaceRoot: payload.root, workspaceTree: payload.tree });
          break;

        case 'INDEX_LOADED':
        case 'INDEX_UPDATED':
          break;

        default:
          break;
      }
    },

    sendCommand(command: UiCommand['command'], payload?: Record<string, unknown>): void {
      const cmd = { command, ...(payload || {}) } as UiCommand;
      if (!isBackendConnected()) {
        if (get().demoMode && command === 'start') {
          simulateDemoFlow((e) => get().handleBackendEvent(e));
          return;
        }
        set({
          lastError: {
            error:
              'Omni backend not connected — your request was not sent. ' +
              'Open the Omni Cockpit inside VS Code, or enable Demo mode.',
            phase: 'idle',
            recoverable: true,
          },
        });
        return;
      }
      postCommand(cmd);
    },

    startNewSession(goal: string, mode: 'chat' | 'code' | 'ask' = 'code'): void {
      console.log('[omniStore] startNewSession called with goal:', goal, 'mode:', mode);
      callIndex.clear();
      const newSessionId = uid('sess');
      set({
        sessionId: newSessionId,
        goal,
        mode,
        messages: [],
        agentStatuses: idleStatuses(),
        completedPhases: [],
        currentPhase: 'idle',
        pendingQuestions: null,
        pendingApproval: null,
        pendingApiKeyPrompt: null,
        lastError: null,
        isRunning: false,
        isStreaming: false,
        isPaused: false,
        artifacts: [],
        reasoningTraces: emptyTraces(),
        recentSessions: [
          {
            id: newSessionId,
            goal,
            timestamp: Date.now(),
            messageCount: 0,
          },
          ...get().recentSessions.slice(0, 9),
        ],
      });
      console.log('[omniStore] About to send command with goal:', goal);
      get().sendCommand('start', { goal, mode });
    },

    continueChat(goal: string): void {
      console.log('[omniStore] continueChat called with goal:', goal);
      set({ isRunning: true, isStreaming: true });
      get().sendCommand('continueChat', { goal });
    },

    setActiveTab(tab: OmniState['activeTab']): void {
      uiSlice.setActiveTab(tab);
    },

    setSidebarOpen(open: boolean): void {
      uiSlice.setSidebarOpen(open);
    },

    setStreaming(streaming: boolean): void {
      set({ isStreaming: streaming });
    },

    clearMessages(): void {
      callIndex.clear();
      set({ messages: [], reasoningTraces: emptyTraces() });
    },

    dismissError(): void {
      set({ lastError: null });
    },

    selectModel(model?: string): void {
      set({ selectedModel: model ?? null });
      get().sendCommand('selectModel', { model });
    },

    configureApi(): void {
      get().sendCommand('configureApi');
    },

    openArtifact(filePath: string): void {
      get().sendCommand('openArtifact', { filePath });
    },

    submitAnswers(answers: ClarifyingAnswer[]): void {
      set({ pendingQuestions: null });
      get().sendCommand('submitAnswers', { answers });
    },

    submitApproval(requestId: string, approved: boolean, feedback?: string): void {
      set({ pendingApproval: null });
      get().sendCommand('submitApproval', { requestId, approved, feedback });
    },

    submitApiKeyPrompt(requestId: string, action: 'proceed' | 'skip' | 'fallback', keys?: Record<string, string>): void {
      set({ pendingApiKeyPrompt: null });
      get().sendCommand('submitApiKeyPrompt', { requestId, action, keys });
    },

    togglePause(): void {
      set({ isPaused: true });
      get().sendCommand('pauseSession');
    },

    stopGeneration(): void {
      set({ isRunning: false, isStreaming: false, isPaused: false });
      get().sendCommand('stopGeneration');
    },

    continueSession(): void {
      set({ isPaused: false });
      get().sendCommand('continueSession');
    },

    exportSession(): void {
      get().sendCommand('exportSession');
    },

    switchAgent(agentId: AgentRole): void {
      get().sendCommand('switchAgent', { agentId });
    },

    requestWorkspace(): void {
      get().sendCommand('requestWorkspace');
    },

    resetSession(): void {
      callIndex.clear();
      // Halt any in-flight backend orchestration so it stops streaming into the
      // freshly cleared session, and clear any pending phase-jump target.
      get().stopGeneration();
      set({
        sessionId: '',
        goal: '',
        messages: [],
        agentStatuses: idleStatuses(),
        completedPhases: [],
        currentPhase: 'idle',
        pendingQuestions: null,
        pendingApproval: null,
        pendingApiKeyPrompt: null,
        lastError: null,
        isRunning: false,
        isStreaming: false,
        isPaused: false,
        artifacts: [],
        reasoningTraces: emptyTraces(),
        workspaceTree: [],
        scrollTargetPhase: null,
      });
    },

    clearScrollTarget(): void {
      pipelineSlice.clearScrollTarget();
    },

    openExternal(url: string): void {
      get().sendCommand('openExternal', { url });
    },

    setChatVerbosity(v: ChatVerbosity): void {
      set({ chatVerbosity: v });
      get().updateSettings({ chatVerbosity: v });
    },

    setUseSupervisor(enabled: boolean): void {
      set({ useSupervisor: enabled });
      get().updateSettings({ useSupervisor: enabled });
    },

    setBudget(budget: OmniState['budget']): void {
      set({ budget });
      get().updateSettings({ budget });
    },

    setPreferredProvider(provider: string): void {
      set({ preferredProvider: provider });
      get().updateSettings({ preferredProvider: provider });
    },

    setDemoMode(enabled: boolean): void {
      set({ demoMode: enabled });
    },

    updateSettings(settings: {
      chatVerbosity?: ChatVerbosity;
      useSupervisor?: boolean;
      budget?: OmniState['budget'];
      preferredProvider?: string;
    }): void {
      get().sendCommand('updateSettings', settings as Record<string, unknown>);
    },

    loadSession(sessionId: string): void {
      get().sendCommand('loadSession', { sessionId });
    },

    deleteSession(sessionId: string): void {
      set((s) => ({
        recentSessions: s.recentSessions.filter((sess) => sess.id !== sessionId),
      }));
      get().sendCommand('deleteSession', { sessionId });
    },
  };

  return { ...initialOmniState, ...actions };
});
