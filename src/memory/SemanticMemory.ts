import * as crypto from 'crypto';
import { generateHashEmbedding, cosineSimilarity } from './vectorUtils';

export interface KnowledgeNode {
  id: string;
  label: string;
  type: 'concept' | 'entity' | 'relation' | 'fact';
  properties: Record<string, any>;
  embeddings?: number[];
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
}

export interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  properties: Record<string, any>;
  createdAt: number;
}

export interface KnowledgePath {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  totalWeight: number;
}

export interface SemanticMemoryConfig {
  maxNodes: number;
  maxEdges: number;
  enableEmbeddings: boolean;
  decayFactor: number;
}

export class SemanticMemory {
  private nodes: Map<string, KnowledgeNode>;
  private edges: Map<string, KnowledgeEdge>;
  private adjacencyList: Map<string, Set<string>>;
  private config: SemanticMemoryConfig;

  constructor(config?: Partial<SemanticMemoryConfig>) {
    this.nodes = new Map();
    this.edges = new Map();
    this.adjacencyList = new Map();
    this.config = {
      maxNodes: 5000,
      maxEdges: 10000,
      enableEmbeddings: false,
      decayFactor: 0.98,
      ...config,
    };
  }

  addNode(node: Omit<KnowledgeNode, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>): string {
    const id = this.generateNodeId(node.label, node.type);
    
    if (this.nodes.has(id)) {
      // Update existing node
      const existing = this.nodes.get(id)!;
      Object.assign(existing.properties, node.properties);
      existing.lastAccessed = Date.now();
      existing.accessCount++;
      return id;
    }

    // Evict if at capacity
    if (this.nodes.size >= this.config.maxNodes) {
      this.evictLeastAccessedNode();
    }

    const newNode: KnowledgeNode = {
      id,
      ...node,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
    };

    this.nodes.set(id, newNode);
    this.adjacencyList.set(id, new Set());
    
    return id;
  }

  addEdge(
    sourceLabel: string,
    targetLabel: string,
    relation: string,
    weight: number = 1.0,
    properties?: Record<string, any>
  ): string {
    const sourceId = this.findOrCreateNode(sourceLabel, 'relation');
    const targetId = this.findOrCreateNode(targetLabel, 'relation');

    const edgeId = this.generateEdgeId(sourceId, targetId, relation);
    
    if (this.edges.has(edgeId)) {
      // Update existing edge
      const existing = this.edges.get(edgeId)!;
      existing.weight = (existing.weight + weight) / 2; // Average weight
      if (properties) {
        Object.assign(existing.properties, properties);
      }
      return edgeId;
    }

    // Evict if at capacity
    if (this.edges.size >= this.config.maxEdges) {
      this.evictWeakestEdge();
    }

    const newEdge: KnowledgeEdge = {
      id: edgeId,
      sourceId,
      targetId,
      relation,
      weight,
      properties: properties || {},
      createdAt: Date.now(),
    };

    this.edges.set(edgeId, newEdge);
    this.adjacencyList.get(sourceId)!.add(targetId);
    this.adjacencyList.get(targetId)!.add(sourceId);

    return edgeId;
  }

  getNode(id: string): KnowledgeNode | undefined {
    const node = this.nodes.get(id);
    if (node) {
      node.lastAccessed = Date.now();
      node.accessCount++;
    }
    return node;
  }

  getEdge(id: string): KnowledgeEdge | undefined {
    return this.edges.get(id);
  }

  findNode(label: string, type?: KnowledgeNode['type']): KnowledgeNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.label === label && (!type || node.type === type)) {
        return node;
      }
    }
    return undefined;
  }

  getNeighbors(nodeId: string): KnowledgeNode[] {
    const neighbors = this.adjacencyList.get(nodeId);
    if (!neighbors) return [];

    return Array.from(neighbors)
      .map(id => this.nodes.get(id))
      .filter((n): n is KnowledgeNode => n !== undefined);
  }

  findPath(
    startLabel: string,
    endLabel: string,
    maxDepth: number = 5
  ): KnowledgePath | null {
    const startNode = this.findNode(startLabel);
    const endNode = this.findNode(endLabel);

    if (!startNode || !endNode) return null;

    // BFS for shortest path
    const queue: Array<{ nodeId: string; path: KnowledgePath }> = [
      { nodeId: startNode.id, path: { nodes: [startNode], edges: [], totalWeight: 0 } },
    ];
    const visited = new Set<string>([startNode.id]);

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;

      if (nodeId === endNode.id) {
        return path;
      }

      if (path.nodes.length >= maxDepth) continue;

      const neighbors = this.adjacencyList.get(nodeId) || new Set();
      
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        visited.add(neighborId);
        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const edgeId = this.generateEdgeId(nodeId, neighborId, '');
        const edge = this.findEdgeBetween(nodeId, neighborId);
        
        if (edge) {
          queue.push({
            nodeId: neighborId,
            path: {
              nodes: [...path.nodes, neighborNode],
              edges: [...path.edges, edge],
              totalWeight: path.totalWeight + edge.weight,
            },
          });
        }
      }
    }

    return null;
  }

  semanticSearch(query: string, limit: number = 10): KnowledgeNode[] {
    if (!this.config.enableEmbeddings) {
      // Fallback to keyword search
      return this.keywordSearch(query, limit);
    }

    const queryEmbedding = generateHashEmbedding(query);
    const scored = Array.from(this.nodes.values()).map(node => ({
      node,
      score: cosineSimilarity(node.embeddings || [], queryEmbedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.node);
  }

  keywordSearch(query: string, limit: number = 10): KnowledgeNode[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    const scored = Array.from(this.nodes.values()).map(node => {
      const labelLower = node.label.toLowerCase();
      let score = 0;

      for (const word of queryWords) {
        if (labelLower.includes(word)) score += 1;
      }

      // Boost by access count
      score += Math.log(node.accessCount + 1);

      return { node, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.node);
  }

  getSubgraph(centerLabel: string, radius: number = 2): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    const centerNode = this.findNode(centerLabel);
    if (!centerNode) return { nodes: [], edges: [] };

    const nodes = new Set<string>([centerNode.id]);
    const edges = new Set<string>();
    const queue = [centerNode.id];

    for (let i = 0; i < radius && queue.length > 0; i++) {
      const currentLevel = [...queue];
      queue.length = 0;

      for (const nodeId of currentLevel) {
        const neighbors = this.adjacencyList.get(nodeId) || new Set();
        
        for (const neighborId of neighbors) {
          if (!nodes.has(neighborId)) {
            nodes.add(neighborId);
            queue.push(neighborId);
          }

          const edge = this.findEdgeBetween(nodeId, neighborId);
          if (edge) {
            edges.add(edge.id);
          }
        }
      }
    }

    return {
      nodes: Array.from(nodes).map(id => this.nodes.get(id)!).filter(n => n !== undefined),
      edges: Array.from(edges).map(id => this.edges.get(id)!).filter(e => e !== undefined),
    };
  }

  removeNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove all edges connected to this node
    const neighbors = this.adjacencyList.get(id) || new Set();
    for (const neighborId of neighbors) {
      const edgeId = this.generateEdgeId(id, neighborId, '');
      this.edges.delete(edgeId);
      this.adjacencyList.get(neighborId)?.delete(id);
    }

    this.nodes.delete(id);
    this.adjacencyList.delete(id);
    return true;
  }

  removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (!edge) return false;

    this.adjacencyList.get(edge.sourceId)?.delete(edge.targetId);
    this.adjacencyList.get(edge.targetId)?.delete(edge.sourceId);
    this.edges.delete(id);
    return true;
  }

  private findOrCreateNode(label: string, type: KnowledgeNode['type']): string {
    const existing = this.findNode(label, type);
    if (existing) return existing.id;

    return this.addNode({
      label,
      type,
      properties: {},
    });
  }

  private findEdgeBetween(sourceId: string, targetId: string): KnowledgeEdge | undefined {
    for (const edge of this.edges.values()) {
      if ((edge.sourceId === sourceId && edge.targetId === targetId) ||
          (edge.sourceId === targetId && edge.targetId === sourceId)) {
        return edge;
      }
    }
    return undefined;
  }

  private generateNodeId(label: string, type: KnowledgeNode['type']): string {
    const hash = crypto.createHash('sha256').update(`${type}:${label}`).digest('hex').substring(0, 8);
    return `node_${hash}`;
  }

  private generateEdgeId(sourceId: string, targetId: string, relation: string): string {
    const hash = crypto.createHash('sha256').update(`${sourceId}:${targetId}:${relation}`).digest('hex').substring(0, 8);
    return `edge_${hash}`;
  }

  private evictLeastAccessedNode(): void {
    let leastAccessed: KnowledgeNode | null = null;
    let lowestAccess = Infinity;

    for (const node of this.nodes.values()) {
      if (node.accessCount < lowestAccess) {
        lowestAccess = node.accessCount;
        leastAccessed = node;
      }
    }

    if (leastAccessed) {
      this.removeNode(leastAccessed.id);
    }
  }

  private evictWeakestEdge(): void {
    let weakest: KnowledgeEdge | null = null;
    let lowestWeight = Infinity;

    for (const edge of this.edges.values()) {
      if (edge.weight < lowestWeight) {
        lowestWeight = edge.weight;
        weakest = edge;
      }
    }

    if (weakest) {
      this.removeEdge(weakest.id);
    }
  }

  restoreNode(node: KnowledgeNode): void {
    this.nodes.set(node.id, node);
    this.adjacencyList.set(node.id, new Set());
  }

  restoreEdge(edge: KnowledgeEdge): void {
    this.edges.set(edge.id, edge);
    this.adjacencyList.get(edge.sourceId)?.add(edge.targetId);
    this.adjacencyList.get(edge.targetId)?.add(edge.sourceId);
  }

  importNodes(nodes: KnowledgeNode[]): void {
    this.nodes.clear();
    this.adjacencyList.clear();
    for (const node of nodes) {
      this.restoreNode(node);
    }
  }

  importEdges(edges: KnowledgeEdge[]): void {
    this.edges.clear();
    for (const edge of edges) {
      this.restoreEdge(edge);
    }
  }

  getAllNodes(): KnowledgeNode[] {
    return Array.from(this.nodes.values());
  }

  getAllEdges(): KnowledgeEdge[] {
    return Array.from(this.edges.values());
  }

  getStats(): {
    totalNodes: number;
    totalEdges: number;
    averageNodeAccess: number;
    averageEdgeWeight: number;
    byType: Record<string, number>;
  } {
    const nodes = Array.from(this.nodes.values());
    const edges = Array.from(this.edges.values());

    const averageNodeAccess = nodes.length > 0
      ? nodes.reduce((sum, n) => sum + n.accessCount, 0) / nodes.length
      : 0;

    const averageEdgeWeight = edges.length > 0
      ? edges.reduce((sum, e) => sum + e.weight, 0) / edges.length
      : 0;

    const byType: Record<string, number> = {};
    for (const node of nodes) {
      byType[node.type] = (byType[node.type] || 0) + 1;
    }

    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      averageNodeAccess,
      averageEdgeWeight,
      byType,
    };
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacencyList.clear();
  }

  getConfig(): SemanticMemoryConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SemanticMemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
