import type { AgentRole, AgentStatus, Phase } from '@/types';

/** Canonical 8-role pipeline agents shown in the UI roster. */
export const CANONICAL_AGENT_ROLES = [
  'orchestrator',
  'clarifier',
  'researcher',
  'planner',
  'coder',
  'auditor',
  'security',
  'verifier',
] as const satisfies readonly AgentRole[];

export const AGENT_META: Record<AgentRole, { label: string; color: string; icon: string; description: string; isOmni?: boolean }> = {
  orchestrator: {
    label: 'Omni',
    color: '#7c6af7',
    icon: '⬡',
    isOmni: true,
    description: 'Главный координатор, управляющий полным жизненным циклом оркестрации',
  },
  clarifier: {
    label: 'Clarifier',
    color: '#a78bfa',
    icon: '◎',
    description: 'Уточнение целей и генерация уточняющих вопросов',
  },
  researcher: {
    label: 'Researcher',
    color: '#3b82f6',
    icon: '◈',
    description: 'Исследования и сбор информации из внешних источников',
  },
  planner: {
    label: 'Planner',
    color: '#10b981',
    icon: '◻',
    description: 'Создание плана выполнения и декомпозиция задач',
  },
  coder: {
    label: 'Coder',
    color: '#f59e0b',
    icon: '◆',
    description: 'Реализация кода и изменения файлов',
  },
  auditor: {
    label: 'Auditor',
    color: '#ec4899',
    icon: '◉',
    description: 'Ревью кода и контроль качества',
  },
  security: {
    label: 'Security',
    color: '#ef4444',
    icon: '⬟',
    description: 'Анализ безопасности и обнаружение уязвимостей',
  },
  verifier: {
    label: 'Verifier',
    color: '#06b6d4',
    icon: '◐',
    description: 'Финальная верификация и тестирование',
  },
  'pre-installer': {
    label: 'Pre-Installer',
    color: '#f59e0b',
    icon: '⚙',
    description: 'Предварительная установка зависимостей маркетплейса',
  },
  'tool-manager': {
    label: 'Tool Manager',
    color: '#ec4899',
    icon: '🛠',
    description: 'Управляет и распределяет инструменты',
  },
  'context-agent': {
    label: 'Context Agent',
    color: '#8b5cf6',
    icon: '📚',
    description: 'Получение и управление контекстом',
  },
};

type AgentMeta = { label: string; color: string; icon: string; description: string; isOmni?: boolean };

const FALLBACK_AGENT: AgentMeta = {
  label: 'Agent',
  color: '#7c6af7',
  icon: '◍',
  description: 'Agent',
};

/** Null-safe agent metadata lookup. The backend may emit auxiliary agent
 *  ids (e.g. 'pre-installer', 'tool-manager', 'context-agent') that are not
 *  part of the canonical 8-role set, so always fall back instead of throwing. */
export function getAgentMeta(role?: string | AgentRole): AgentMeta {
  const map = AGENT_META as Record<string, AgentMeta>;
  return role && map[role] ? map[role] : FALLBACK_AGENT;
}

export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#6b7280',
  working: '#f59e0b',
  done: '#10b981',
  blocked: '#f97316',
  error: '#ef4444',
};

/** Null-safe status → color. Falls back to idle color for unknown statuses. */
export function getStatusColor(status?: AgentStatus | string): string {
  return (STATUS_COLORS as Record<string, string>)[status as string] ?? STATUS_COLORS.idle;
}

export const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Простой',
  working: 'Работает',
  done: 'Готово',
  blocked: 'Заблокирован',
  error: 'Ошибка',
};

export const PHASE_LABELS: Record<Phase, string> = {
  idle: 'Простой',
  intake: 'Получение',
  research: 'Исследование',
  planning: 'Планирование',
  build: 'Сборка',
  audit: 'Аудит',
  security: 'Безопасность',
  verify: 'Верификация',
  deliver: 'Доставка',
  consult: 'Консультация',
};

export const PHASE_COLORS: Record<Phase, string> = {
  idle: '#6b7280',
  intake: '#a78bfa',
  research: '#3b82f6',
  planning: '#10b981',
  build: '#f59e0b',
  audit: '#ec4899',
  security: '#ef4444',
  verify: '#06b6d4',
  deliver: '#10b981',
  consult: '#a78bfa',
};

export const TOOL_ICONS: Record<string, string> = {
  bash: '💻',
  execute_bash: '💻',
  browser: '🌐',
  search: '🔍',
  web_search: '🔍',
  read_file: '📄',
  write_file: '✍️',
  edit_file: '📝',
  todo: '✅',
  list_todo: '📋',
  memory: '🧠',
  think: '💭',
  default: '🔧',
};

export function getToolIcon(toolName: string): string {
  const lower = toolName.toLowerCase();
  const exact = TOOL_ICONS[lower];
  if (exact) return exact;
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return TOOL_ICONS.default;
}

/** Categorize a tool by name for visual grouping in the UI. */
export function getToolCategory(toolName: string): 'shell' | 'file' | 'web' | 'plan' | 'default' {
  const lower = toolName.toLowerCase();
  if (lower.includes('bash') || lower.includes('terminal') || lower.includes('shell') || lower.includes('execute')) return 'shell';
  if (lower.includes('write_file') || lower.includes('read_file') || lower.includes('edit') || lower.includes('file')) return 'file';
  if (lower.includes('search') || lower.includes('web') || lower.includes('browser') || lower.includes('fetch')) return 'web';
  if (lower.includes('todo') || lower.includes('plan') || lower.includes('task')) return 'plan';
  return 'default';
}
