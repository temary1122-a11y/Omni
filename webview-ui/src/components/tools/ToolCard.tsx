import { useState, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { MessagePart } from '@/types';
import { cn } from '@/utils/cn';
import { getToolIcon, getToolCategory } from '@/utils/agentConfig';
import { monoBoxStyle } from '@/styles/mono';
import { useOmniStore } from '@/store/omniStore';
import { useTranslation } from '@/i18n';
import { ChevronRight, Loader2, Check, AlertCircle } from 'lucide-react';

type ToolPart = Extract<MessagePart, { type: 'tool_call' }>;

/** Pull unique, ordered http(s) URLs out of a tool result body. */
function extractUrls(text: string): string[] {
  const matches = typeof text === 'string' ? text.match(/https?:\/\/[^\s)]+/gi) : null;
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of matches) {
    const key = u.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const monoBox: CSSProperties = { ...monoBoxStyle, maxHeight: 260 };

function TerminalView({ part }: { part: ToolPart }) {
  const command = s(part.args?.command);
  const output = s(part.output);
  return (
    <div style={monoBox}>
      {command && (
        <div style={{ color: 'var(--vscode-terminal-ansiGreen, #3fb950)', marginBottom: 4 }}>
          <span style={{ color: 'var(--color-text-secondary, #8b949e)', marginRight: 4 }}>$</span>
          {command}
        </div>
      )}
      {output && <div style={{ marginTop: command ? 6 : 0, whiteSpace: 'pre-wrap' }}>{output}</div>}
    </div>
  );
}

function BrowserView({ part }: { part: ToolPart }) {
  const openExternal = useOmniStore((s) => s.openExternal);
  const output = s(part.output);
  const urls = extractUrls(output);
  const linkStyle: CSSProperties = {
    ...monoBox,
    display: 'block',
    width: '100%',
    cursor: 'pointer',
    textAlign: 'left',
    color: 'var(--vscode-textLink-foreground, #7c6af7)',
    background: 'none',
    border: 'none',
    padding: 0,
    wordBreak: 'break-all',
  };
  return (
    <div>
      {urls.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {urls.map((u, i) => (
            <button key={i} type="button" onClick={() => openExternal(u)} style={linkStyle}>
              🔗 {u}
            </button>
          ))}
        </div>
      ) : output ? (
        <div style={monoBox}>{output}</div>
      ) : (
        <div style={monoBox}>—</div>
      )}
    </div>
  );
}

function FileView({ part }: { part: ToolPart }) {
  const openArtifact = useOmniStore((s) => s.openArtifact);
  const path = s(part.args?.path);
  const content = s(part.output) || s(part.args?.content);
  return (
    <div>
      {path && (
        <button
          type="button"
          onClick={() => openArtifact(path)}
          style={{
            fontSize: 12,
            color: 'var(--vscode-textLink-foreground, #7c6af7)',
            marginBottom: 6,
            cursor: 'pointer',
            background: 'none',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
          }}
        >
          📄 {path}
        </button>
      )}
      <pre style={monoBox}>{content || '—'}</pre>
    </div>
  );
}

function TodoView({ part }: { part: ToolPart }) {
  const todos = part.args?.todos;
  if (Array.isArray(todos) && todos.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {todos.map((t, i) => {
          const todo = t as { text?: string; content?: string; done?: boolean; checked?: boolean };
          const label = s(todo.text ?? todo.content ?? t);
          const done = Boolean(todo.done ?? todo.checked);
          return (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={done} readOnly />
              <span style={{ textDecoration: done ? 'line-through' : 'none', color: 'var(--vscode-foreground, #e6e6e6)' }}>
                {label}
              </span>
            </label>
          );
        })}
      </div>
    );
  }
  return <pre style={monoBox}>{JSON.stringify(part.args ?? {}, null, 2)}</pre>;
}

function ResultBody({ part }: { part: ToolPart }) {
  const text = s(part.output) || s(part.error) || JSON.stringify(part.args ?? {}, null, 2);
  return <pre style={monoBox}>{text}</pre>;
}

function renderBody(part: ToolPart) {
  const name = part.toolName.toLowerCase();
  if (name.includes('bash') || name.includes('terminal') || name.includes('shell')) return <TerminalView part={part} />;
  if (name.includes('search') || name.includes('web')) return <BrowserView part={part} />;
  if (name.includes('write_file') || name.includes('read_file') || name.includes('edit')) return <FileView part={part} />;
  if (name.includes('todo') || name.includes('plan')) return <TodoView part={part} />;
  return <ResultBody part={part} />;
}

// Category-based accent colors for visual differentiation
const CATEGORY_COLORS: Record<string, string> = {
  shell: '#3fb950',
  file: '#58a6ff',
  web: '#d29922',
  plan: '#a78bfa',
  default: '#8b949e',
};

export function ToolCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const status = part.status ?? 'running';
  const success = part.success;
  const category = getToolCategory(part.toolName);
  const accentColor = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.default;

  // Status icon
  const StatusIcon = status === 'running'
    ? () => <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
    : success
      ? () => <Check size={13} />
      : () => <AlertCircle size={13} />;

  const statusColor = status === 'running'
    ? 'var(--color-warning, #d29922)'
    : success
      ? 'var(--color-success, #3fb950)'
      : 'var(--color-error, #f85149)';

  // Category label for the badge
  const categoryLabel = category === 'shell' ? 'Terminal'
    : category === 'file' ? 'File'
    : category === 'web' ? 'Web'
    : category === 'plan' ? 'Plan'
    : 'Tool';

  return (
    <div
      className="omni-tool-card omni-fade-up"
      style={{
        background: 'var(--color-bg-secondary, #0d1117)',
        border: `1px solid var(--color-border, #30363d)`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 'var(--radius-md, 8px)',
        padding: 0,
        margin: '6px 0',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Category icon */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 'var(--radius-sm, 6px)',
            fontSize: 13,
            flexShrink: 0,
            background: `${accentColor}1a`,
            border: `1px solid ${accentColor}33`,
          }}
        >
          {getToolIcon(part.toolName)}
        </span>

        {/* Tool name + category */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 600, color: 'var(--color-text-primary, #e6e6e6)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {part.toolName}
          </span>
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary, #8b949e)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {categoryLabel}
          </span>
        </div>

        {/* Status icon */}
        <span style={{ display: 'flex', alignItems: 'center', color: statusColor, flexShrink: 0 }}>
          <StatusIcon />
        </span>

        {/* Chevron */}
        <ChevronRight
          size={14}
          style={{
            color: 'var(--color-text-secondary, #8b949e)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Body */}
      {open && (
        <div
          style={{
            padding: '0 10px 10px',
            borderTop: `1px solid var(--color-border-light, rgba(255,255,255,0.06))`,
          }}
        >
          <div style={{ marginTop: 8 }}>
            {renderBody(part)}
          </div>
        </div>
      )}
    </div>
  );
}
