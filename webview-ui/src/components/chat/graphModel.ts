import type { AgentRole, AgentStatus, Message, MessagePart, Phase } from '@/types';

export type GraphNodeKind = 'orchestrator' | 'agent' | 'file' | 'tool' | 'consult' | 'task';

export interface OperationalGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  accent: string;
  status?: AgentStatus;
  phase?: Phase;
  meta: string[];
  order?: number;
}

export interface OperationalGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'spawn' | 'tool' | 'artifact' | 'consult' | 'context';
  label: string;
  detail: string;
  animated?: boolean;
}

export interface OperationalGraphModel {
  nodes: OperationalGraphNode[];
  edges: OperationalGraphEdge[];
  summary: {
    agentCount: number;
    fileCount: number;
    toolCount: number;
    eventCount: number;
  };
}

const KIND_ACCENTS: Record<GraphNodeKind, string> = {
  orchestrator: '#8b5cf6',
  task: '#06b6d4',
  agent: '#60a5fa',
  file: '#f59e0b',
  tool: '#34d399',
  consult: '#f472b6',
};

function shortText(value: string, max = 110): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function fileLabel(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function partSummary(part: MessagePart): string | null {
  switch (part.type) {
    case 'reasoning':
      return shortText(part.content, 80);
    case 'commentary':
      return shortText(part.message, 80);
    case 'tool_call':
      return shortText(part.toolName, 80);
    case 'agent_consult':
      return shortText(part.question, 80);
    case 'artifact':
      return shortText(part.filePath, 80);
    case 'phase':
      return `${part.from} → ${part.to}`;
    case 'delivery':
      return shortText(part.report.summary ?? 'delivery', 80);
    default:
      return null;
  }
}

function rankAgent(agentId: AgentRole, count: number, preferredProvider: string): number {
  const seed = [...agentId, ...preferredProvider].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return seed + count * 17;
}

export function buildOperationalGraph(input: {
  goal: string;
  currentPhase: Phase;
  sessionId: string;
  messages: Message[];
  agentStatuses: Record<AgentRole, AgentStatus>;
  reasoningTraces: Record<AgentRole, string[]>;
  artifacts: string[];
  providerInfo: Record<string, { hasKey: boolean; budget: string }>;
  preferredProvider: string;
}): OperationalGraphModel {
  const agentStats = new Map<
    AgentRole,
    {
      count: number;
      firstEvent: string;
      lastEvent: string;
      lastPhase: Phase;
      status: AgentStatus;
      toolCount: number;
      fileCount: number;
      consultCount: number;
      latestSnippet: string;
    }
  >();
  const toolStats = new Map<string, { count: number; latest: string }>();
  const fileStats = new Map<string, { count: number; latest: string }>();
  const consultStats = new Map<string, { count: number; latest: string }>();
  const edges: OperationalGraphEdge[] = [];
  const seenAgentSpawn = new Set<string>();
  let eventCount = 0;

  const ensureAgent = (agentId: AgentRole, phase: Phase = input.currentPhase) => {
    if (!agentStats.has(agentId)) {
      agentStats.set(agentId, {
        count: 0,
        firstEvent: '',
        lastEvent: '',
        lastPhase: phase,
        status: input.agentStatuses[agentId] ?? 'idle',
        toolCount: 0,
        fileCount: 0,
        consultCount: 0,
        latestSnippet: '',
      });
    }
    return agentStats.get(agentId)!;
  };

  const recordAgentEvent = (agentId: AgentRole, phase: Phase, summary: string) => {
    const stats = ensureAgent(agentId, phase);
    stats.count += 1;
    stats.lastPhase = phase;
    stats.lastEvent = summary;
    stats.status = input.agentStatuses[agentId] ?? stats.status;
    stats.latestSnippet = summary;
    if (!stats.firstEvent) stats.firstEvent = summary;
    eventCount += 1;
    return stats;
  };

  const addSpawnEdge = (agentId: AgentRole, detail: string) => {
    if (seenAgentSpawn.has(agentId)) return;
    seenAgentSpawn.add(agentId);
    edges.push({
      id: `spawn:${agentId}`,
      source: 'orchestrator',
      target: `agent:${agentId}`,
      kind: 'spawn',
      label: 'spawn',
      detail,
      animated: true,
    });
  };

  for (const [agentId, traces] of Object.entries(input.reasoningTraces) as [AgentRole, string[]][]) {
    if (traces.length > 0) {
      const stats = ensureAgent(agentId, input.currentPhase);
      stats.count += traces.length;
      stats.latestSnippet = shortText(traces[traces.length - 1], 80);
      stats.lastEvent = stats.latestSnippet;
      stats.firstEvent ||= shortText(traces[0], 80);
      stats.status = input.agentStatuses[agentId] ?? stats.status;
      eventCount += traces.length;
      addSpawnEdge(agentId, `Reasoning started: ${stats.firstEvent}`);
    }
  }

  for (const message of input.messages) {
    for (const part of message.parts) {
      const summary = partSummary(part);
      if (!summary) continue;

      switch (part.type) {
        case 'reasoning': {
          const agentId = part.agentId;
          const stats = recordAgentEvent(agentId, part.phase, summary);
          addSpawnEdge(agentId, stats.firstEvent || summary);
          break;
        }
        case 'commentary': {
          const agentId = part.agentId;
          recordAgentEvent(agentId, part.phase, summary);
          addSpawnEdge(agentId, summary);
          break;
        }
        case 'tool_call': {
          if (!part.agentId) break;
          const stats = recordAgentEvent(part.agentId, message.phase ?? input.currentPhase, `${part.toolName}`);
          stats.toolCount += 1;
          addSpawnEdge(part.agentId, summary);
          const toolId = `tool:${part.toolName}`;
          const prev = toolStats.get(toolId) ?? { count: 0, latest: '' };
          toolStats.set(toolId, { count: prev.count + 1, latest: `${part.toolName}` });
          edges.push({
            id: `tool:${part.callId ?? `${message.id}:${part.toolName}`}`,
            source: `agent:${part.agentId}`,
            target: toolId,
            kind: 'tool',
            label: part.toolName,
            detail: part.args ? JSON.stringify(part.args) : `Tool ${part.toolName}`,
            animated: true,
          });
          break;
        }
        case 'artifact': {
          const agentId = (part.agentId ?? 'orchestrator') as AgentRole;
          const stats = ensureAgent(agentId, message.phase ?? input.currentPhase);
          stats.fileCount += 1;
          stats.lastEvent = `Artifact ${shortText(part.filePath, 70)}`;
          stats.latestSnippet = stats.lastEvent;
          addSpawnEdge(agentId, `Artifact touched: ${part.filePath}`);
          const fileId = `file:${part.filePath}`;
          const prev = fileStats.get(fileId) ?? { count: 0, latest: '' };
          fileStats.set(fileId, { count: prev.count + 1, latest: message.id });
          edges.push({
            id: `artifact:${message.id}:${part.filePath}`,
            source: `agent:${agentId}`,
            target: fileId,
            kind: 'artifact',
            label: 'artifact',
            detail: part.filePath,
            animated: true,
          });
          break;
        }
        case 'agent_consult': {
          const from = part.from as AgentRole;
          const to = part.to;
          const stats = recordAgentEvent(from, message.phase ?? input.currentPhase, summary);
          stats.consultCount += 1;
          addSpawnEdge(from, `Consulted ${to}: ${summary}`);
          ensureAgent(to, message.phase ?? input.currentPhase);
          const consultId = `consult:${from}:${to}:${message.id}`;
          consultStats.set(consultId, { count: (consultStats.get(consultId)?.count ?? 0) + 1, latest: summary });
          edges.push({
            id: consultId,
            source: `agent:${from}`,
            target: `agent:${to}`,
            kind: 'consult',
            label: `${from} → ${to}`,
            detail: `${part.question}${part.answer ? `\nAnswer: ${part.answer}` : ''}`,
            animated: true,
          });
          break;
        }
        case 'phase':
          eventCount += 1;
          break;
        case 'delivery':
          eventCount += 1;
          break;
        default:
          eventCount += 1;
          break;
      }
    }
  }

  for (const filePath of input.artifacts) {
    const fileId = `file:${filePath}`;
    if (!fileStats.has(fileId)) fileStats.set(fileId, { count: 1, latest: 'artifact list' });
  }

  const agentNodes = [...agentStats.entries()]
    .sort((a, b) => rankAgent(a[0], a[1].count, input.preferredProvider) - rankAgent(b[0], b[1].count, input.preferredProvider))
    .map(([agentId, stats], index) => ({
      id: `agent:${agentId}`,
      kind: 'agent' as const,
      label: agentId,
      detail: stats.latestSnippet || stats.lastEvent || stats.firstEvent || 'Waiting for activity',
      accent: KIND_ACCENTS.agent,
      status: stats.status,
      phase: stats.lastPhase,
      meta: [
        `${stats.count} events`,
        `${stats.toolCount} tools`,
        `${stats.fileCount} files`,
        `${stats.consultCount} consults`,
      ],
      order: index,
    }));

  // Cap tool/file nodes to prevent ReactFlow performance collapse
  const MAX_TOOL_NODES = 15;
  const MAX_FILE_NODES = 15;

  const fileEntries = [...fileStats.entries()].slice(-MAX_FILE_NODES);
  const toolEntries = [...toolStats.entries()].slice(-MAX_TOOL_NODES);

  const fileNodes = fileEntries.map(([id, stats], index) => ({
    id,
    kind: 'file' as const,
    label: fileLabel(id.replace(/^file:/, '')),
    detail: id.replace(/^file:/, ''),
    accent: KIND_ACCENTS.file,
    meta: [`${stats.count} touches`, stats.latest ? `last ${shortText(stats.latest, 28)}` : ''],
      order: index,
  }));

  const toolNodes = toolEntries.map(([id, stats], index) => ({
    id,
    kind: 'tool' as const,
    label: id.replace(/^tool:/, ''),
    detail: stats.latest,
    accent: KIND_ACCENTS.tool,
    meta: [`${stats.count} calls`],
      order: index,
  }));

  const taskNode: OperationalGraphNode = {
    id: 'task',
    kind: 'task',
    label: input.sessionId ? 'Active task' : 'Task compass',
    detail: input.goal || 'Waiting for a goal',
    accent: KIND_ACCENTS.task,
    phase: input.currentPhase,
    meta: [input.currentPhase],
  };

  const orchestratorNode: OperationalGraphNode = {
    id: 'orchestrator',
    kind: 'orchestrator',
    label: 'Orchestrator',
    detail: `${input.currentPhase} • ${input.preferredProvider}`,
    accent: KIND_ACCENTS.orchestrator,
    phase: input.currentPhase,
    meta: [
      `${Object.values(input.agentStatuses).filter((s) => s !== 'idle').length} active agents`,
      `${Object.keys(input.providerInfo).filter((provider) => input.providerInfo[provider]?.hasKey).length} keys`,
    ],
  };

  const taskEdges: OperationalGraphEdge[] = [
    {
      id: 'task:orchestrator',
      source: 'task',
      target: 'orchestrator',
      kind: 'context',
      label: 'task compass',
      detail: input.goal || 'No goal yet',
      animated: false,
    },
  ];

  return {
    nodes: [taskNode, orchestratorNode, ...agentNodes, ...toolNodes, ...fileNodes],
    edges: [...taskEdges, ...edges],
    summary: {
      agentCount: agentNodes.length,
      fileCount: fileNodes.length,
      toolCount: toolNodes.length,
      eventCount,
    },
  };
}

export function kindAccent(kind: GraphNodeKind): string {
  return KIND_ACCENTS[kind];
}
