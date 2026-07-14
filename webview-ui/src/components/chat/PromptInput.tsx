import { useState, useRef, useEffect, useMemo } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { Play, Pause, Square, X, ChevronDown, Zap } from 'lucide-react';
import { useOmniStore } from '@/store/omniStore';
import { useTranslation } from '@/i18n';
import { OmniLogo } from '@/components/common/OmniLogo';

/**
 * PromptInput
 * ---------------------------------------------------------------------------
 * Unified composer bar: textarea + inline action buttons (model selector,
 * start/pause/stop). Replaces the previous 3-branch conditional with a
 * single composer that adapts its controls to session state.
 */

const ACCENT = 'var(--color-primary, #7c6af7)';
const BORDER = 'var(--color-border, #30363d)';
const FG = 'var(--color-text-primary, #e6e6e6)';
const DESC = 'var(--color-text-secondary, #8b949e)';
const WARN = 'var(--color-warning, #d29922)';
const ERR = 'var(--color-error, #f85149)';
const GREEN = 'var(--color-success, #3fb950)';

export function PromptInput() {
  const { t } = useTranslation();
  const sessionId = useOmniStore((s) => s.sessionId);
  const goal = useOmniStore((s) => s.goal);
  const isRunning = useOmniStore((s) => s.isRunning);
  const isStreaming = useOmniStore((s) => s.isStreaming);
  const isPaused = useOmniStore((s) => s.isPaused);
  const startNewSession = useOmniStore((s) => s.startNewSession);
  const continueChat = useOmniStore((s) => s.continueChat);
  const togglePause = useOmniStore((s) => s.togglePause);
  const stopGeneration = useOmniStore((s) => s.stopGeneration);
  const clearMessages = useOmniStore((s) => s.clearMessages);
  const modelCatalog = useOmniStore((s) => s.modelCatalog);
  const selectModel = useOmniStore((s) => s.selectModel);
  const currentModel = useOmniStore((s) => s.selectedModel);

  const [value, setValue] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const hasSession = Boolean(sessionId);
  const busy = isRunning || isStreaming;

  // Flatten model catalog for quick lookup
  const allModels = useMemo(() => {
    const out: { provider: string; model: string }[] = [];
    for (const [provider, models] of Object.entries(modelCatalog)) {
      for (const model of models) {
        out.push({ provider, model });
      }
    }
    return out;
  }, [modelCatalog]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  // Close model dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setValue('');
    if (hasSession) {
      continueChat(trimmed);
    } else {
      startNewSession(trimmed, 'chat');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = hasSession
    ? (busy ? t('chat.generationInProgress') : t('chat.describeBuild'))
    : (goal ? t('chat.refineTask') : t('chat.describeBuild'));

  return (
    <div
      style={{
        padding: 'var(--space-3, 12px)',
        borderTop: `1px solid ${BORDER}`,
        background: 'var(--color-bg-tertiary, rgba(255,255,255,0.02))',
        flexShrink: 0,
        overflow: 'visible',
      }}
    >
      {/* Status bar (when busy) */}
      {busy && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            marginBottom: 8,
            borderRadius: 'var(--radius-md, 8px)',
            background: 'var(--color-bg-secondary, #0d1117)',
            border: `1px solid ${BORDER}`,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isPaused ? DESC : WARN,
              animation: !isPaused ? 'omni-blink 1s steps(1) infinite' : 'none',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 'var(--font-size-sm, 12px)', fontWeight: 600, color: isPaused ? DESC : WARN }}>
            {isPaused ? 'Пауза' : t('chat.running')}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button
              type="button"
              onClick={togglePause}
              title={isPaused ? t('toolbar.continue') : t('toolbar.pause')}
              aria-label={isPaused ? t('toolbar.continue') : t('toolbar.pause')}
              style={controlBtn(true, isPaused ? GREEN : WARN)}
            >
              {isPaused ? <Play size={14} /> : <Pause size={14} />}
            </button>
            <button
              type="button"
              onClick={stopGeneration}
              title={t('toolbar.stop')}
              aria-label={t('toolbar.stop')}
              style={controlBtn(true, ERR)}
            >
              <Square size={13} style={{ fill: 'currentColor' }} />
            </button>
          </div>
        </div>
      )}

      {/* Composer row */}
      <div style={{ display: 'flex', gap: 'var(--space-2, 8px)', alignItems: 'flex-end', overflow: 'visible' }}>
        {/* Model selector button */}
        <div style={{ position: 'relative', flexShrink: 0 }} ref={modelDropdownRef}>
          <button
            type="button"
            onClick={() => setModelOpen(!modelOpen)}
            title={currentModel || t('sidebar.selectModel')}
            aria-label={t('sidebar.selectModel')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              height: 40,
              padding: '0 10px',
              borderRadius: 'var(--radius-md, 8px)',
              fontSize: 'var(--font-size-sm, 12px)',
              fontWeight: 500,
              cursor: 'pointer',
              color: currentModel ? ACCENT : DESC,
              background: currentModel ? `${ACCENT}14` : 'var(--color-bg-secondary, #0d1117)',
              border: `1px solid ${currentModel ? `${ACCENT}55` : BORDER}`,
              transition: 'border-color 150ms ease',
              maxWidth: 140,
            }}
          >
            <Zap size={13} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentModel ? currentModel.split('/').pop() : 'Model'}
            </span>
            <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
          </button>

          {modelOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                left: 0,
                minWidth: 200,
                maxHeight: 320,
                overflowY: 'auto',
                padding: '6px',
                borderRadius: 8,
                background: 'var(--color-bg-secondary, #0d1117)',
                border: `1px solid ${BORDER}`,
                boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.5))',
                zIndex: 100,
              }}
            >
              {allModels.length === 0 ? (
                <div style={{ padding: '8px 10px', fontSize: 12, color: DESC }}>Нет доступных моделей</div>
              ) : (
                allModels.map(({ provider, model }) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => {
                      selectModel(model);
                      setModelOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: model === currentModel ? `${ACCENT}14` : 'transparent',
                      border: 'none',
                      color: model === currentModel ? ACCENT : FG,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{model.split('/').pop()}</span>
                    <span style={{ fontSize: 10, color: DESC }}>{provider}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy && !isPaused}
          rows={2}
          placeholder={placeholder}
          style={{
            flex: 1,
            resize: 'none',
            padding: '10px 12px',
            borderRadius: 'var(--radius-md, 8px)',
            fontSize: 'var(--font-size-base, 14px)',
            lineHeight: 'var(--line-height-normal, 1.5)',
            fontFamily: 'inherit',
            background: 'var(--color-bg-secondary, #0d1117)',
            border: `1px solid ${BORDER}`,
            color: FG,
            outline: 'none',
            transition: 'border-color 150ms ease',
            overflow: 'auto',
            opacity: busy && !isPaused ? 0.6 : 1,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = `${ACCENT}88`;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = BORDER;
          }}
        />

        {/* Send / Start button */}
        <button
          type="button"
          disabled={!value.trim() && !hasSession}
          onClick={submit}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            height: 40,
            padding: '0 16px',
            borderRadius: 'var(--radius-md, 8px)',
            fontSize: 'var(--font-size-base, 14px)',
            fontWeight: 'var(--font-weight-semibold, 600)',
            cursor: value.trim() ? 'pointer' : 'not-allowed',
            opacity: value.trim() ? 1 : 0.5,
            background: ACCENT,
            border: 'none',
            color: '#fff',
            flexShrink: 0,
            transition: 'opacity 150ms ease',
            zIndex: 10,
          }}
        >
          {hasSession ? (
            <Play size={14} />
          ) : (
            <>
              <OmniLogo size={14} color="#fff" />
              {t('welcome.run')}
            </>
          )}
        </button>

        {/* Clear button (when session exists and not busy) */}
        {hasSession && !busy && (
          <button
            type="button"
            onClick={clearMessages}
            title={t('chat.clear')}
            aria-label={t('chat.clear')}
            style={controlBtn(true, DESC)}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function controlBtn(enabled: boolean, color: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    width: 40,
    borderRadius: 'var(--radius-md, 8px)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.4,
    background: 'transparent',
    border: `1px solid ${color}55`,
    color,
    flexShrink: 0,
  };
}
