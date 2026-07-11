import { useOmniStore } from '@/store/omniStore';
import { STATUS_LABELS, getAgentMeta, getStatusColor } from '@/utils/agentConfig';
import { cn } from '@/utils/cn';
import type { AgentRole, AgentStatus } from '@/types';

/**
 * AgentCard
 * ---------------------------------------------------------------------------
 * Compact tile used in the Agents overview grid. Clicking selects the agent
 * and opens its detail panel. Shows identity + live status.
 */

export function AgentCard({ role }: { role: AgentRole }) {
  const meta = getAgentMeta(role);
  const status = useOmniStore((s): AgentStatus => s.agentStatuses[role]);
  const selectedAgentId = useOmniStore((s) => s.selectedAgentId);
  const showAgentDetail = useOmniStore((s) => s.showAgentDetail);
  const setSelectedAgent = useOmniStore((s) => s.setSelectedAgent);
  const setShowAgentDetail = useOmniStore((s) => s.setShowAgentDetail);

  const statusColor = getStatusColor(status);
  const isSelected = selectedAgentId === role;
  const isOpen = isSelected && showAgentDetail;
  const isWorking = status === 'working';

  const handleClick = () => {
    setSelectedAgent(role);
    setShowAgentDetail(true);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn('omni-agent-card')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: 12,
        borderRadius: 12,
        cursor: 'pointer',
        color: 'var(--vscode-foreground, #e6e6e6)',
        background: isSelected
          ? 'var(--vscode-list-activeSelectionBackground, #161b22)'
          : 'var(--vscode-sideBar-background, #0d1117)',
        border: `1px solid ${isSelected ? meta.color : 'var(--vscode-panel-border, #30363d)'}`,
        boxShadow: isWorking ? `0 0 12px ${meta.color}33` : 'none',
        outline: isOpen ? `1px solid ${meta.color}` : 'none',
        transition: 'border-color 150ms ease, background 150ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: 8,
            fontSize: 18,
            color: meta.color,
            background: 'var(--vscode-widget-background, #161b22)',
          }}
        >
          {meta.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: meta.color }}>{meta.label}</div>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 9999,
              background: statusColor,
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 10, color: statusColor }}>{STATUS_LABELS[status]}</span>
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: 1.4,
          color: 'var(--vscode-descriptionForeground, #8b949e)',
        }}
      >
        {meta.description}
      </p>
    </button>
  );
}
