import { MessageSquareQuote } from 'lucide-react';
import type { AgentRole, Phase } from '@/types';
import { getAgentMeta, PHASE_LABELS } from '@/utils/agentConfig';
import { useTranslation } from '@/i18n';

interface CommentaryBlockProps {
  agentId: AgentRole;
  phase: Phase;
  message: string;
  highlight?: boolean;
}

export function CommentaryBlock({ agentId, phase, message, highlight }: CommentaryBlockProps) {
  const meta = getAgentMeta(agentId);
  const { t } = useTranslation();
  return (
    <div
      className="omni-fade-up"
      style={{
        display: 'flex',
        gap: 10,
        margin: '8px 0',
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${highlight ? `${meta.color}55` : 'var(--color-border, #30363d)'}`,
        background: highlight ? `${meta.color}12` : 'var(--color-bg-tertiary, rgba(255,255,255,0.03))',
        boxShadow: highlight ? `0 0 20px ${meta.color}18` : 'none',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          background: `${meta.color}22`,
          border: `1px solid ${meta.color}44`,
          color: meta.color,
        }}
      >
        {meta.icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          <MessageSquareQuote size={12} style={{ color: meta.color }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.label}</span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.05)',
              color: 'var(--color-text-secondary, #8b949e)',
            }}
          >
            {t('commentary.title')}
          </span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.05)',
              color: 'var(--color-text-secondary, #8b949e)',
            }}
          >
            {PHASE_LABELS[phase]}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--color-text-primary, #e6e6e6)' }}>
          {message}
        </p>
      </div>
    </div>
  );
}
