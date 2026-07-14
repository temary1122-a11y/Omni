import type { CSSProperties } from 'react';
import { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Square,
  Settings,
  MoreVertical,
  RotateCcw,
  Download,
  X,
  CheckCircle2,
} from 'lucide-react';
import { useOmniStore } from '@/store/omniStore';
import { PHASE_LABELS, PHASE_COLORS, AGENT_META } from '@/utils/agentConfig';
import { cn } from '@/utils/cn';
import { useTranslation } from '@/i18n';
import { OmniLogo } from '@/components/common/OmniLogo';

/**
 * Toolbar
 * ---------------------------------------------------------------------------
 * Top application bar: branding, mode toggle (Code/Chat/Plan), live phase chip + goal,
 * an inline error chip, and simplified session controls (pause/continue/stop + dropdown).
 */

const ACCENT = 'var(--color-primary, #7c6af7)';
const BORDER = 'var(--color-border, #30363d)';
const FG = 'var(--color-text-primary, #e6e6e6)';
const DESC = 'var(--color-text-secondary, #8b949e)';
const ERROR = 'var(--color-error, #f85149)';

export function Toolbar() {
  const { t } = useTranslation();
  const currentPhase = useOmniStore((s) => s.currentPhase);
  const goal = useOmniStore((s) => s.goal);
  const isRunning = useOmniStore((s) => s.isRunning);
  const isStreaming = useOmniStore((s) => s.isStreaming);
  const isPaused = useOmniStore((s) => s.isPaused);
  const lastError = useOmniStore((s) => s.lastError);
  const sessionId = useOmniStore((s) => s.sessionId);
  const completedPhases = useOmniStore((s) => s.completedPhases);
  const agentStatuses = useOmniStore((s) => s.agentStatuses);
  const togglePause = useOmniStore((s) => s.togglePause);
  const stopGeneration = useOmniStore((s) => s.stopGeneration);
  const continueSession = useOmniStore((s) => s.continueSession);
  const clearMessages = useOmniStore((s) => s.clearMessages);
  const exportSession = useOmniStore((s) => s.exportSession);
  const dismissError = useOmniStore((s) => s.dismissError);
  const configureApi = useOmniStore((s) => s.configureApi);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasSession = Boolean(sessionId) || isRunning;
  const phaseLabel = PHASE_LABELS[currentPhase] ?? currentPhase;
  const phaseColor = PHASE_COLORS[currentPhase] ?? ACCENT;

  // Calculate active agents
  const activeAgents = Object.entries(agentStatuses)
    .filter(([, status]) => status === 'working')
    .map(([id]) => AGENT_META[id as keyof typeof AGENT_META]?.label)
    .filter(Boolean);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header
      className={cn('omni-toolbar')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 48,
        flexShrink: 0,
        padding: '0 12px',
        borderBottom: `1px solid ${BORDER}`,
        background: 'var(--color-bg-secondary, #0d1117)',
        color: FG,
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            color: '#fff',
            background: ACCENT,
            boxShadow: '0 0 12px rgba(124,106,247,0.4)',
          }}
        >
          <OmniLogo size={15} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>Omni</span>
      </div>

      {/* Phase chip */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 9999,
          fontSize: 11,
          fontWeight: 600,
          flexShrink: 0,
          color: phaseColor,
          background: `${phaseColor}1f`,
          border: `1px solid ${phaseColor}55`,
          textTransform: 'capitalize',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 9999,
            background: phaseColor,
            opacity: isStreaming ? 1 : 0.5,
          }}
        />
        {phaseLabel}
      </span>

      {/* Goal (truncated) */}
      {goal && (
        <span
          title={goal}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--font-size-base, 13px)',
            fontWeight: 'var(--font-weight-medium, 500)',
            color: DESC,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {goal}
        </span>
      )}

      {/* Active agents indicator */}
      {activeAgents.length > 0 && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-xs, 11px)', color: 'var(--color-warning, #d29922)', flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-warning, #d29922)', animation: 'omni-blink 1s steps(1) infinite' }} />
          {activeAgents.length} {t('toolbar.activeAgents')}
        </span>
      )}

      {/* Completed phases */}
      {completedPhases.length > 0 && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 'var(--font-size-xs, 11px)',
            color: DESC,
            flexShrink: 0,
          }}
          title={`${completedPhases.length} ${t('toolbar.phasesComplete')}`}
        >
          <CheckCircle2 size={13} />
          {completedPhases.length}
        </span>
      )}

      {/* Spacer (when no goal) */}
      {!goal && <div style={{ flex: 1, minWidth: 0 }} />}

      {/* Error chip */}
      {lastError && (
        <span
          title={lastError.error}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: 240,
            padding: '4px 8px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            flexShrink: 0,
            color: ERROR,
            background: `${ERROR}1a`,
            border: `1px solid ${ERROR}55`,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {lastError.error}
          </span>
          <button
            type="button"
            onClick={() => dismissError()}
            title={t('toolbar.dismissError')}
            aria-label={t('toolbar.dismissError')}
            style={iconBtnStyle(ERROR)}
          >
            <X size={12} />
          </button>
        </span>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {hasSession && isRunning && !isPaused && (
          <button
            type="button"
            onClick={() => togglePause()}
            title={t('toolbar.pause')}
            aria-label={t('toolbar.pause')}
            style={iconBtnStyle(FG)}
          >
            <Pause size={14} />
          </button>
        )}

        {hasSession && isPaused && (
          <button
            type="button"
            onClick={() => continueSession()}
            title={t('toolbar.continue')}
            aria-label={t('toolbar.continue')}
            style={iconBtnStyle(FG)}
          >
            <Play size={14} />
          </button>
        )}

        {hasSession && (isRunning || isPaused) && (
          <button
            type="button"
            onClick={() => stopGeneration()}
            title={t('toolbar.stop')}
            aria-label={t('toolbar.stop')}
            style={iconBtnStyle(ERROR)}
          >
            <Square size={13} />
          </button>
        )}

        {/* Dropdown menu */}
        <div style={{ position: 'relative' }} ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            title={t('toolbar.moreOptions')}
            aria-label={t('toolbar.moreOptions')}
            style={iconBtnStyle(FG)}
          >
            <MoreVertical size={14} />
          </button>

          {dropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                minWidth: 160,
                padding: '6px',
                borderRadius: 8,
                background: 'var(--color-bg-secondary, #0d1117)',
                border: `1px solid ${BORDER}`,
                boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.5))',
                zIndex: 100,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  clearMessages();
                  setDropdownOpen(false);
                }}
                style={dropdownItemStyle()}
              >
                <RotateCcw size={14} style={{ marginRight: 8 }} />
                {t('toolbar.clearChat')}
              </button>
              <button
                type="button"
                onClick={() => {
                  exportSession();
                  setDropdownOpen(false);
                }}
                style={dropdownItemStyle()}
              >
                <Download size={14} style={{ marginRight: 8 }} />
                {t('toolbar.exportSession')}
              </button>
              <button
                type="button"
                onClick={() => {
                  configureApi();
                  setDropdownOpen(false);
                }}
                style={dropdownItemStyle()}
              >
                <Settings size={14} style={{ marginRight: 8 }} />
                {t('toolbar.configureApi')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function iconBtnStyle(color: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 6,
    cursor: 'pointer',
    color,
    background: 'transparent',
    border: '1px solid transparent',
    transition: 'background 150ms ease, border-color 150ms ease',
  };
}

function dropdownItemStyle(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    color: FG,
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    transition: 'background 150ms ease',
  };
}
