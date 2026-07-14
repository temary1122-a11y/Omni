import { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type EdgeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useOmniStore } from '@/store/omniStore';
import { cn } from '@/utils/cn';
import { buildOperationalGraph, type GraphNodeKind, type OperationalGraphNode } from './graphModel';

type GraphNodeData = OperationalGraphNode & { kind: GraphNodeKind };

function graphNodeClass(kind: GraphNodeKind, selected: boolean): string {
  const base = 'min-w-[152px] max-w-[220px] rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md transition-all';
  const tone: Record<GraphNodeKind, string> = {
    orchestrator: 'bg-violet-950/70 text-violet-50',
    task: 'bg-cyan-950/70 text-cyan-50',
    agent: 'bg-slate-900/85 text-slate-50',
    file: 'bg-amber-950/75 text-amber-50',
    tool: 'bg-emerald-950/75 text-emerald-50',
    consult: 'bg-pink-950/75 text-pink-50',
  };
  const border = selected ? 'ring-2 ring-white/70 shadow-white/10' : 'ring-1 ring-white/10';
  return cn(base, tone[kind], border);
}

function OperationalGraphNodeView({ data, selected }: NodeProps<GraphNodeData>) {
  return (
    <div className={graphNodeClass(data.kind, selected ?? false)} style={{ borderColor: data.accent }}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-white/80" />
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-white/80" />
      <div className="flex items-start gap-2">
        <div className="mt-1 h-2.5 w-2.5 rounded-full" style={{ background: data.accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-wide">{data.label}</div>
          <div
            className="mt-0.5 text-[11px] leading-4 text-white/70"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {data.detail}
          </div>
        </div>
      </div>
      {data.meta.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.meta.filter(Boolean).slice(0, 3).map((meta) => (
            <span key={meta} className="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-[10px] text-white/75">
              {meta}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function placeOnArc<T extends GraphNodeData>(
  nodes: T[],
  radius: number,
  startDeg: number,
  endDeg: number,
  yOffset = 0
): Node<T>[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) {
    const node = nodes[0];
    return [
      {
        id: node.id,
        type: 'graphNode',
        position: { x: radius, y: yOffset },
        data: node,
        draggable: false,
        selectable: true,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      },
    ];
  }

  return nodes.map((node, index) => {
    const t = index / Math.max(nodes.length - 1, 1);
    const angle = ((startDeg + (endDeg - startDeg) * t) * Math.PI) / 180;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius + yOffset;
    return {
      id: node.id,
      type: 'graphNode',
      position: { x, y },
      data: node,
      draggable: false,
      selectable: true,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });
}

function GraphAutoFit({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    fitView({ padding: 0.18, includeHiddenNodes: false, maxZoom: 1.1, minZoom: 0.45, duration: 250 });
  }, [fitView, nodeCount, edgeCount]);

  return null;
}

export function OperationalGraphPanel() {
  const sessionId = useOmniStore((s) => s.sessionId);
  const goal = useOmniStore((s) => s.goal);
  const currentPhase = useOmniStore((s) => s.currentPhase);
  const messages = useOmniStore((s) => s.messages);
  const agentStatuses = useOmniStore((s) => s.agentStatuses);
  const reasoningTraces = useOmniStore((s) => s.reasoningTraces);
  const artifacts = useOmniStore((s) => s.artifacts);
  const providerInfo = useOmniStore((s) => s.providerInfo);
  const preferredProvider = useOmniStore((s) => s.preferredProvider);
  const activityLog = useOmniStore((s) => s.activityLog);

  const model = useMemo(
    () =>
      buildOperationalGraph({
        goal,
        currentPhase,
        sessionId,
        messages,
        agentStatuses,
        reasoningTraces,
        artifacts,
        providerInfo,
        preferredProvider,
      }),
    [goal, currentPhase, sessionId, messages, agentStatuses, reasoningTraces, artifacts, providerInfo, preferredProvider]
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string>('orchestrator');
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  useEffect(() => {
    if (!model.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId('orchestrator');
    }
  }, [model.nodes, selectedNodeId]);

  const selectedNode = model.nodes.find((node) => node.id === selectedNodeId) ?? model.nodes[0];
  const hoveredEdge = hoveredEdgeId ? model.edges.find((edge) => edge.id === hoveredEdgeId) : null;

  const nodes = useMemo(() => {
    const root = model.nodes.find((node) => node.id === 'task');
    const orchestrator = model.nodes.find((node) => node.id === 'orchestrator');
    const agents = model.nodes.filter((node) => node.kind === 'agent').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const tools = model.nodes.filter((node) => node.kind === 'tool').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const files = model.nodes.filter((node) => node.kind === 'file').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const positioned: Node<GraphNodeData>[] = [
      ...(root
        ? [
            {
              id: root.id,
              type: 'graphNode',
              position: { x: 0, y: -210 },
              data: root,
              draggable: false,
              selectable: true,
              sourcePosition: Position.Bottom,
              targetPosition: Position.Bottom,
            },
          ]
        : []),
      ...(orchestrator
        ? [
            {
              id: orchestrator.id,
              type: 'graphNode',
              position: { x: 0, y: 0 },
              data: orchestrator,
              draggable: false,
              selectable: true,
              sourcePosition: Position.Bottom,
              targetPosition: Position.Top,
            },
          ]
        : []),
      ...placeOnArc(agents, 240, -160, 160),
      ...placeOnArc(tools, 320, -30, 40, 10),
      ...placeOnArc(files, 330, 140, 240, 20),
    ];
    return positioned;
  }, [model.nodes]);

  const edges = useMemo(() => {
    return model.edges.map((edge): Edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: edge.animated ?? false,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
      style: {
        strokeWidth: 1.4,
        stroke: edge.kind === 'spawn' ? '#8b5cf6' : edge.kind === 'artifact' ? '#f59e0b' : edge.kind === 'tool' ? '#34d399' : edge.kind === 'consult' ? '#f472b6' : '#94a3b8',
        opacity: hoveredEdgeId && hoveredEdgeId !== edge.id ? 0.25 : 0.85,
      },
      labelStyle: {
        fill: '#e2e8f0',
        fontSize: 10,
        fontWeight: 600,
      },
      data: edge,
    }));
  }, [model.edges, hoveredEdgeId]);

  const onEdgeMouseEnter: EdgeMouseHandler = (_, edge) => setHoveredEdgeId(edge.id);
  const onEdgeMouseLeave: EdgeMouseHandler = () => setHoveredEdgeId(null);

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0a0f18]">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Live operational graph</div>
            <div className="text-sm font-semibold text-white/90">Agents, files, tools, and context as they happen</div>
          </div>
          <div className="text-right text-[11px] text-white/45">
            <div>{model.summary.agentCount} agents</div>
            <div>{model.summary.fileCount} files</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/60">
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">Phase: {currentPhase}</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">Provider: {preferredProvider}</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">{model.summary.eventCount} events</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
        <div className="relative min-h-[460px]">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={{ graphNode: OperationalGraphNodeView }}
              fitView
              fitViewOptions={{ padding: 0.18, includeHiddenNodes: false, maxZoom: 1.1, minZoom: 0.45 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              defaultEdgeOptions={{ type: 'smoothstep' }}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId('orchestrator')}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              proOptions={{ hideAttribution: true }}
            >
              <GraphAutoFit nodeCount={nodes.length} edgeCount={edges.length} />
              <Background color="#1f2937" gap={28} variant={BackgroundVariant.Dots} size={1.2} />
              <Controls showInteractive={false} className="!bg-black/30 !text-white" />
              <MiniMap
                pannable
                zoomable
                className="!bg-black/35"
                nodeStrokeWidth={2}
                nodeColor={(n) => (n.data as GraphNodeData).accent}
              />
            </ReactFlow>
          </ReactFlowProvider>
          {hoveredEdge && (
            <div className="pointer-events-none absolute left-3 top-3 max-w-[300px] rounded-2xl border border-white/10 bg-black/80 px-3 py-2 text-[11px] text-white/85 shadow-2xl backdrop-blur">
              <div className="font-semibold uppercase tracking-[0.18em] text-white/45">{hoveredEdge.label}</div>
              <div className="mt-1 whitespace-pre-wrap leading-5 text-white/80">{hoveredEdge.detail}</div>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 bg-white/5 px-4 py-3 text-[11px] text-white/75">
          <div className="grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">Selected node</div>
              <div className="mt-1 text-sm font-semibold text-white/90">{selectedNode?.label ?? 'Orchestrator'}</div>
              <div className="mt-1 whitespace-pre-wrap leading-5 text-white/70">
                {selectedNode?.detail ?? 'No node selected yet.'}
              </div>
              {selectedNode?.meta?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selectedNode.meta.filter(Boolean).map((item) => (
                    <span key={item} className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-white/70">
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">Recent activity</div>
              {activityLog.length > 0 ? (
                activityLog.slice(-3).reverse().map((line) => (
                  <div key={line} className="rounded-xl border border-white/10 bg-black/15 px-2.5 py-2 leading-5 text-white/70">
                    {line}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 bg-black/10 px-2.5 py-3 text-white/45">
                  Hover a link or click a node to inspect it here.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
