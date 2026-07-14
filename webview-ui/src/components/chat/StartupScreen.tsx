import { useState } from 'react';
import { Plus, Clock, Trash2, KeyRound, ExternalLink } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useOmniStore } from '@/store/omniStore';
import { OmniLogo } from '@/components/common/OmniLogo';

const ACCENT = 'var(--color-primary, #7c6af7)';
const BORDER = 'var(--color-border, #30363d)';
const FG = 'var(--color-text-primary, #e6e6e6)';
const DESC = 'var(--color-text-secondary, #8b949e)';

export function StartupScreen({ onStartNewSession }: { onStartNewSession: (goal: string, mode: 'chat' | 'code' | 'ask') => void }) {
  const [value, setValue] = useState('');
  const recentSessions = useOmniStore((s) => s.recentSessions);
  const loadSession = useOmniStore((s) => s.loadSession);
  const deleteSession = useOmniStore((s) => s.deleteSession);
  const openExternal = useOmniStore((s) => s.openExternal);

  const handleStart = () => {
    if (value.trim()) {
      onStartNewSession(value.trim(), 'chat');
    }
  };

  const handleLoadSession = (sessionId: string) => {
    loadSession(sessionId);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Только что';
    if (diffMins < 60) return `${diffMins} мин. назад`;
    if (diffHours < 24) return `${diffHours} ч. назад`;
    if (diffDays < 7) return `${diffDays} дн. назад`;
    return date.toLocaleDateString('ru-RU');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
        padding: 24,
        background: 'var(--color-bg-primary, #0b0d12)',
      }}
    >
      {/* Greeting */}
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            borderRadius: 14,
            marginBottom: 16,
            color: '#fff',
            background: 'var(--color-primary, #7c6af7)',
            boxShadow: '0 0 24px rgba(124,106,247,0.4)',
          }}
        >
          <OmniLogo size={32} color="#fff" />
        </div>
        <h1
          style={{
            fontSize: 'var(--font-size-4xl, 32px)',
            margin: '0 0 12px 0',
            color: FG,
            fontWeight: 'var(--font-weight-bold, 700)',
          }}
        >
          Привет, я Омни
        </h1>
        <p style={{ color: DESC, fontSize: 'var(--font-size-base, 14px)', maxWidth: 400, margin: 0 }}>
          Мульти-агентная система для планирования, сборки и верификации кода
        </p>
      </div>

      <div style={{ width: '100%', maxWidth: 520, marginBottom: 24 }}>
        <div style={{ marginBottom: 8, color: DESC, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          API ключи для Smart-free
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => openExternal('https://openrouter.ai/keys')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 8,
              background: '#161b22',
              border: `1px solid ${BORDER}`,
              color: FG,
              cursor: 'pointer',
            }}
          >
            <KeyRound size={14} />
            OpenRouter
            <ExternalLink size={12} />
          </button>
          <button
            type="button"
            onClick={() => openExternal('https://api.kilo.ai/account/api-keys')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 8,
              background: '#161b22',
              border: `1px solid ${BORDER}`,
              color: FG,
              cursor: 'pointer',
            }}
          >
            <KeyRound size={14} />
            Kilo Gateway
            <ExternalLink size={12} />
          </button>
        </div>
      </div>

      {/* New Session Input */}
      <div style={{ width: '100%', maxWidth: 520, marginBottom: 40 }}>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Опишите задачу…"
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            padding: 12,
            borderRadius: 'var(--radius-md, 8px)',
            fontSize: 'var(--font-size-base, 14px)',
            background: 'var(--color-bg-secondary, #0d1117)',
            border: `1px solid ${BORDER}`,
            color: FG,
            outline: 'none',
            marginBottom: 12,
          }}
        />
        <button
          type="button"
          disabled={!value.trim()}
          onClick={handleStart}
          className={cn('omni-run-btn')}
          style={{
            width: '100%',
            padding: '10px 24px',
            borderRadius: 'var(--radius-md, 8px)',
            fontSize: 'var(--font-size-base, 14px)',
            fontWeight: 'var(--font-weight-semibold, 600)',
            cursor: value.trim() ? 'pointer' : 'not-allowed',
            opacity: value.trim() ? 1 : 0.5,
            background: ACCENT,
            border: 'none',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Plus size={16} />
          Начать новую сессию
        </button>
      </div>

      {/* Recent Sessions */}
      {recentSessions.length > 0 && (
        <div style={{ width: '100%', maxWidth: 520 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 16,
              color: DESC,
              fontSize: 'var(--font-size-sm, 12px)',
              fontWeight: 'var(--font-weight-semibold, 600)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            <Clock size={14} />
            Недавние сессии
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => handleLoadSession(session.id)}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: 12,
                  borderRadius: 'var(--radius-md, 8px)',
                  background: 'var(--color-bg-secondary, #0d1117)',
                  border: `1px solid ${BORDER}`,
                  color: FG,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 150ms ease, border-color 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = `${BORDER}33`;
                  e.currentTarget.style.borderColor = ACCENT;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-secondary, #0d1117)';
                  e.currentTarget.style.borderColor = BORDER;
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--font-size-base, 13px)',
                      fontWeight: 'var(--font-weight-medium, 500)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginBottom: 4,
                    }}
                  >
                    {session.goal}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: DESC }}>
                    <span>{formatDate(session.timestamp)}</span>
                    <span>•</span>
                    <span>{session.messageCount} сообщений</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(e) => handleDeleteSession(e, session.id)}
                  title="Удалить сессию"
                  aria-label="Удалить сессию"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: 'transparent',
                    border: 'none',
                    color: DESC,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = `${BORDER}55`;
                    e.currentTarget.style.color = 'var(--color-error, #f85149)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = DESC;
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
