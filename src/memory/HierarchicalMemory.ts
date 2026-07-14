/**
 * Hierarchical Memory Coordinator (Phase 2.3 + Phase 3.1 + Phase 3.2)
 *
 * Coordinates multiple memory layers:
 * - Working Memory (current session context)
 * - Episodic Memory (events with semantic retrieval)
 * - Procedural Memory (skills and patterns)
 * - Semantic Memory (knowledge graph)
 */

import { WorkingMemory } from './WorkingMemory';
import { EpisodicMemory, Episode, EpisodeType, EpisodeQuery, SearchResult } from './EpisodicMemory';
import { ProceduralMemory, Skill, SkillMatch } from './ProceduralMemory';
import { SemanticMemory, KnowledgeNode, KnowledgeEdge, KnowledgePath } from './SemanticMemory';

export interface HierarchicalMemoryConfig {
  episodicHalfLifeMs?: number;
  retrievalLimit?: number;
  proceduralMaxSkills?: number;
  proceduralSuccessThreshold?: number;
  semanticMaxNodes?: number;
  semanticMaxEdges?: number;
}

export class HierarchicalMemory {
  readonly workingMemory: WorkingMemory;
  readonly episodicMemory: EpisodicMemory;
  readonly proceduralMemory: ProceduralMemory;
  readonly semanticMemory: SemanticMemory;

  private retrievalLimit: number;

  constructor(config?: HierarchicalMemoryConfig) {
    this.workingMemory = new WorkingMemory();
    this.episodicMemory = new EpisodicMemory({
      halfLifeMs: config?.episodicHalfLifeMs,
    });
    this.proceduralMemory = new ProceduralMemory({
      maxSkills: config?.proceduralMaxSkills,
      successRateThreshold: config?.proceduralSuccessThreshold,
    });
    this.semanticMemory = new SemanticMemory({
      maxNodes: config?.semanticMaxNodes,
      maxEdges: config?.semanticMaxEdges,
    });
    this.retrievalLimit = config?.retrievalLimit ?? 10;
  }

  /**
   * Record an episode and keep working memory updated.
   */
  recordEpisode(
    type: EpisodeType,
    data: Record<string, unknown>,
    importance = 0.5
  ): Episode {
    return this.episodicMemory.add({ type, data, importance });
  }

  /**
   * Selectively retrieve episodes relevant to a query, to augment working memory.
   */
  selectiveRetrieve(query: string, minImportance = 0): SearchResult[] {
    return this.episodicMemory.search(query, this.retrievalLimit, minImportance);
  }

  /**
   * Get recent episodes of a given type.
   */
  recentEpisodes(type: EpisodeType, limit = 10): Episode[] {
    return this.episodicMemory
      .getByType(type)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Apply decay across episodic memory.
   */
  applyDecay(): void {
    this.episodicMemory.applyDecay();
  }

  /**
   * Register a skill in procedural memory.
   */
  registerSkill(skill: Omit<Skill, 'id' | 'createdAt' | 'successRate' | 'usageCount' | 'lastUsed'>): string {
    return this.proceduralMemory.registerSkill(skill);
  }

  /**
   * Record a skill execution.
   */
  recordSkillExecution(skillId: string, execution: Omit<Skill['metadata'], 'skillId' | 'timestamp'>): void {
    this.proceduralMemory.recordExecution(skillId, {
      success: execution.success ?? true,
      durationMs: execution.durationMs ?? 0,
      context: execution.context ?? {},
      outcome: execution.outcome ?? {},
    });
  }

  /**
   * Find the best skill for a given query.
   */
  findBestSkill(query: string, category?: Skill['category'], context?: Record<string, any>): SkillMatch | null {
    return this.proceduralMemory.findBestSkill(query, category, context);
  }

  /**
   * Get the top-N skill matches for a query.
   */
  findTopSkills(
    query: string,
    category?: Skill['category'],
    limit = 3,
    context?: Record<string, any>
  ): SkillMatch[] {
    return this.proceduralMemory.findTopSkills(query, category, limit, context);
  }

  /**
   * Get skills by category.
   */
  getSkillsByCategory(category: Skill['category']): Skill[] {
    return this.proceduralMemory.findSkillsByCategory(category);
  }

  /**
   * Get all skills.
   */
  getAllSkills(): Skill[] {
    return this.proceduralMemory.getAllSkills();
  }

  /**
   * Add a knowledge node to semantic memory.
   */
  addKnowledgeNode(node: Omit<KnowledgeNode, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>): string {
    return this.semanticMemory.addNode(node);
  }

  /**
   * Add a knowledge edge to semantic memory.
   */
  addKnowledgeEdge(
    sourceLabel: string,
    targetLabel: string,
    relation: string,
    weight?: number,
    properties?: Record<string, any>
  ): string {
    return this.semanticMemory.addEdge(sourceLabel, targetLabel, relation, weight, properties);
  }

  /**
   * Semantic search in knowledge graph.
   */
  semanticSearch(query: string, limit?: number): KnowledgeNode[] {
    return this.semanticMemory.semanticSearch(query, limit);
  }

  /**
   * Find path between two concepts in knowledge graph.
   */
  findKnowledgePath(startLabel: string, endLabel: string, maxDepth?: number): KnowledgePath | null {
    return this.semanticMemory.findPath(startLabel, endLabel, maxDepth);
  }

  /**
   * Get subgraph around a concept.
   */
  getKnowledgeSubgraph(centerLabel: string, radius?: number): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    return this.semanticMemory.getSubgraph(centerLabel, radius);
  }

  /**
   * Full reset of all memory layers.
   */
  clear(): void {
    this.workingMemory.clear();
    this.episodicMemory.clear();
    this.proceduralMemory.clear();
    this.semanticMemory.clear();
  }

  /**
   * Summary of memory state for diagnostics.
   */
  getDiagnostics(): {
    workingMemory: { hasGoal: boolean; hasPlan: boolean; hasContext: boolean };
    episodicMemory: { episodeCount: number };
    proceduralMemory: { skillCount: number; averageSuccessRate: number };
    semanticMemory: { nodeCount: number; edgeCount: number; averageNodeAccess: number };
  } {
    const wm = this.workingMemory;
    const proceduralStats = this.proceduralMemory.getStats();
    const semanticStats = this.semanticMemory.getStats();
    return {
      workingMemory: {
        hasGoal: wm.getGoalPacket() !== null,
        hasPlan: wm.getExecutionPlan() !== null,
        hasContext: wm.getContextPacket() !== null,
      },
      episodicMemory: {
        episodeCount: this.episodicMemory.size(),
      },
      proceduralMemory: {
        skillCount: proceduralStats.totalSkills,
        averageSuccessRate: proceduralStats.averageSuccessRate,
      },
      semanticMemory: {
        nodeCount: semanticStats.totalNodes,
        edgeCount: semanticStats.totalEdges,
        averageNodeAccess: semanticStats.averageNodeAccess,
      },
    };
  }
}
