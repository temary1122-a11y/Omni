import { useOmniStore } from '@/store/omniStore';
import { MessageList } from './MessageList';
import { PromptInput } from './PromptInput';
import { ClarifyingQuestions } from './ClarifyingQuestions';
import { ApprovalCard } from './ApprovalCard';
import { ApiKeyPromptCard } from './ApiKeyPromptCard';
import { StartupScreen } from './StartupScreen';
import { OperationalGraphPanel } from './OperationalGraphPanel';

export function ChatView() {
  const sessionId = useOmniStore((s) => s.sessionId);
  const messages = useOmniStore((s) => s.messages);
  const pendingQuestions = useOmniStore((s) => s.pendingQuestions);
  const pendingApproval = useOmniStore((s) => s.pendingApproval);
  const pendingApiKeyPrompt = useOmniStore((s) => s.pendingApiKeyPrompt);
  const startNewSession = useOmniStore((s) => s.startNewSession);
  const submitAnswers = useOmniStore((s) => s.submitAnswers);
  const submitApproval = useOmniStore((s) => s.submitApproval);

  const noSession = sessionId === '' && messages.length === 0;

  return (
    <div className="omni-chat-workspace" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) clamp(340px, 38vw, 560px)', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {noSession ? (
          <StartupScreen onStartNewSession={(goal, mode) => startNewSession(goal, mode)} />
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex' }}>
              <MessageList messages={messages} />
            </div>

            {pendingQuestions && (
              <div style={{ padding: '0 12px', flexShrink: 0, maxHeight: '50vh', overflowY: 'auto', overflowX: 'hidden' }}>
                <ClarifyingQuestions questions={pendingQuestions} onSubmit={submitAnswers} />
              </div>
            )}

            {pendingApproval && (
              <div style={{ padding: '0 12px', flexShrink: 0, maxHeight: '50vh', overflowY: 'auto', overflowX: 'hidden' }}>
                <ApprovalCard
                  approval={pendingApproval}
                  onApprove={(fb) => submitApproval(pendingApproval.requestId, true, fb)}
                  onReject={(fb) => submitApproval(pendingApproval.requestId, false, fb)}
                />
              </div>
            )}

            {pendingApiKeyPrompt && (
              <div style={{ padding: '0 12px', flexShrink: 0, maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden' }}>
                <ApiKeyPromptCard prompt={pendingApiKeyPrompt} />
              </div>
            )}

            <PromptInput />
          </>
        )}
      </div>

      <OperationalGraphPanel />
    </div>
  );
}
