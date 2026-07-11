/**
 * MemoryFacade (Phase 3 Integration)
 *
 * Singleton facade over HierarchicalMemory layers.
 * All agents and the orchestrator share a single instance per workspaceRoot,
 * preventing memory isolation and enabling cross-agent knowledge sharing.
 *
 * Usage:
 *   const memory = MemoryFacade.getInstance(workspaceRoot);
 *   memory.recordEpisode('tool_step', { toolName, success, excerpt });
 *   const relevant = memory.selectiveRetrieve(goal, 3, 0.4);
 */

import { HierarchicalMemory, HierarchicalMemoryConfig } from './HierarchicalMemory';
import type { EpisodeType, Episode, SearchResult } from './EpisodicMemory';
import type { Skill, SkillMatch } from './ProceduralMemory';
import type { KnowledgeNode } from './SemanticMemory';
import * as fs from 'fs';
import * as path from 'path';

export interface MemoryFacadeConfig extends HierarchicalMemoryConfig {
  /** Minimum importance threshold for recordEpisode (episodes below are skipped). Default: 0 */
  recordEpisodeImportanceThreshold?: number;
  /** Max characters of memory context injected into prompts. Default: 3200 (~800 tokens) */
  maxPromptMemoryChars?: number;
  /** Top-N episodes returned by selectiveRetrieve. Default: 5 */
  retrievalLimit?: number;
}

export class MemoryFacade {
  private static instances: Map<string, MemoryFacade> = new Map();

  private memory: HierarchicalMemory;
  private importanceThreshold: number;
  private maxPromptMemoryChars: number;
  private topN: number;
  private workspaceRoot: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private meta: Record<string, any> | null = null;

  private constructor(config?: MemoryFacadeConfig, workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot || '';
    this.memory = new HierarchicalMemory({
      episodicHalfLifeMs: config?.episodicHalfLifeMs,
      retrievalLimit: config?.retrievalLimit ?? 10,
      proceduralMaxSkills: config?.proceduralMaxSkills,
      proceduralSuccessThreshold: config?.proceduralSuccessThreshold,
      semanticMaxNodes: config?.semanticMaxNodes,
      semanticMaxEdges: config?.semanticMaxEdges,
    });
    this.importanceThreshold = config?.recordEpisodeImportanceThreshold ?? 0;
    this.maxPromptMemoryChars = config?.maxPromptMemoryChars ?? 3200;
    this.topN = config?.retrievalLimit ?? 5;
  }

  /**
   * Get or create the singleton instance for the given workspaceRoot.
   * Pass config only on first call — subsequent calls ignore it.
   */
  static getInstance(workspaceRoot: string, config?: MemoryFacadeConfig): MemoryFacade {
    if (!MemoryFacade.instances.has(workspaceRoot)) {
      const inst = new MemoryFacade(config, workspaceRoot);
      MemoryFacade.instances.set(workspaceRoot, inst);
      inst.loadFromDisk();
    }
    return MemoryFacade.instances.get(workspaceRoot)!;
  }

  /**
   * Destroy the instance for the given workspaceRoot (e.g., on workspace switch).
   */
  static destroyInstance(workspaceRoot: string): void {
    const inst = MemoryFacade.instances.get(workspaceRoot);
    if (inst) {
      inst.clear();
      MemoryFacade.instances.delete(workspaceRoot);
    }
  }

  // ─── Episodic Memory ──────────────────────────────────────────────────────

  /**
   * Record a new episode. Skips if importance is below configured threshold.
   */
  recordEpisode(
    type: EpisodeType,
    data: Record<string, unknown>,
    importance: number = 0.5
  ): void {
    if (importance < this.importanceThreshold) return;
    this.memory.recordEpisode(type, data, importance);
  }

  /**
   * Retrieve recent episodes of a given type.
   */
  recentEpisodes(type: EpisodeType, limit: number = 10): Episode[] {
    return this.memory.recentEpisodes(type, limit);
  }

  /**
   * Selectively retrieve the top-N relevant episodes for a query.
   * Respects configured retrievalLimit.
   */
  selectiveRetrieve(
    query: string,
    limit?: number,
    minImportance: number = 0
  ): SearchResult[] {
    return this.memory.selectiveRetrieve(query, minImportance).slice(0, limit ?? this.topN);
  }

  /**
   * Build a memory context block suitable for injection into an LLM prompt.
   * Guarantees the result will not exceed maxPromptMemoryChars.
   */
  buildMemoryContextBlock(query: string, limit?: number): string {
    const results = this.selectiveRetrieve(query, limit ?? 3, 0.3);
    if (results.length === 0) return '';

    const lines = results.map((r) => {
      const ep = r.episode;
      const agentId = (ep.data as any).agentId ?? '?';
      const excerpt = (ep.data as any).excerpt ?? JSON.stringify(ep.data).slice(0, 160);
      return `[${ep.type}@${agentId}] ${excerpt}`;
    });

    const block = `System (relevant memory):\n${lines.join('\n')}\n`;
    // Truncate to maxPromptMemoryChars to avoid token overflow
    return block.length <= this.maxPromptMemoryChars
      ? block
      : block.slice(0, this.maxPromptMemoryChars) + '\n... (truncated)\n';
  }

  // ─── Procedural Memory ────────────────────────────────────────────────────

  /**
   * Register a new skill pattern.
   */
  registerSkill(
    skill: Omit<Skill, 'id' | 'createdAt' | 'successRate' | 'usageCount' | 'lastUsed'>
  ): string {
    return this.memory.registerSkill(skill);
  }

  /**
   * Find the best matching skill for a query.
   */
  findBestSkill(
    query: string,
    category?: Skill['category'],
    context?: Record<string, any>
  ): SkillMatch | null {
    return this.memory.findBestSkill(query, category, context);
  }

  /**
   * Get all registered skills.
   */
  getAllSkills(): Skill[] {
    return this.memory.getAllSkills();
  }

  /**
   * Record skill execution outcome.
   */
  recordSkillExecution(
    skillId: string,
    result: { success: boolean; durationMs: number; context?: Record<string, any>; outcome?: any }
  ): void {
    this.memory.recordSkillExecution(skillId, {
      success: result.success,
      durationMs: result.durationMs,
      context: result.context ?? {},
      outcome: result.outcome ?? {},
    });
  }

  // ─── Semantic Memory ──────────────────────────────────────────────────────

  /**
   * Add a knowledge node (symbol, concept, entity) to the semantic graph.
   */
  addKnowledgeNode(
    node: Omit<KnowledgeNode, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>
  ): string {
    return this.memory.addKnowledgeNode(node);
  }

  /**
   * Add a directed edge between two labels in the semantic graph.
   */
  addKnowledgeEdge(
    sourceLabel: string,
    targetLabel: string,
    relation: string,
    weight?: number,
    properties?: Record<string, any>
  ): string {
    return this.memory.addKnowledgeEdge(sourceLabel, targetLabel, relation, weight, properties);
  }

  /**
   * Keyword / semantic search over the knowledge graph.
   */
  semanticSearch(query: string, limit?: number): KnowledgeNode[] {
    return this.memory.semanticSearch(query, limit ?? this.topN);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Apply decay to episodic memory (call periodically). */
  applyDecay(): void {
    this.memory.applyDecay();
  }

  /** Full reset of all memory layers. */
  clear(): void {
    this.memory.clear();
  }

  /** Diagnostics snapshot for debugging. */
  getDiagnostics() {
    return this.memory.getDiagnostics();
  }

  /** Expose underlying HierarchicalMemory for advanced use-cases. */
  getRawMemory(): HierarchicalMemory {
    return this.memory;
  }

  private getMemoryDir(): string {
    if (!this.workspaceRoot) return '';
    return path.join(this.workspaceRoot, '.omniflow', 'memory');
  }

  /** Debounced flush to avoid blocking the event loop. */
  flushToDisk(immediate = false): void {
    if (!this.workspaceRoot) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const doFlush = () => {
      try {
        const dir = this.getMemoryDir();
        fs.mkdirSync(dir, { recursive: true });
        const eps = this.memory.episodicMemory.getAll();
        const lines = eps.map((ep) => JSON.stringify({
          id: ep.id,
          timestamp: ep.timestamp,
          type: ep.type,
          data: this.scrubSecrets(ep.data),
          importance: ep.importance,
          embedding: ep.embedding,
        }));
        fs.writeFileSync(path.join(dir, 'episodes.jsonl'), lines.join('\n'), 'utf-8');
        fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify(this.memory.proceduralMemory.getAllSkills(), null, 2), 'utf-8');
        const semanticNodes = this.memory.semanticMemory.getAllNodes();
        const semanticEdges = this.memory.semanticMemory.getAllEdges();
        fs.writeFileSync(path.join(dir, 'semantic-nodes.json'), JSON.stringify({ nodes: semanticNodes, edges: semanticEdges }, null, 2), 'utf-8');
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...this.meta, version: 1, updatedAt: Date.now() }, null, 2), 'utf-8');
      } catch {
        // best-effort persistence
      }
    };
    if (immediate) {
      doFlush();
    } else {
      this.flushTimer = setTimeout(doFlush, 2000);
    }
  }

  private scrubSecrets(data: any): any {
    if (data === null || typeof data !== 'object') return data;
    if (Array.isArray(data)) {
      return data.map((item) => this.scrubSecrets(item));
    }
    const sensitiveKeys = new Set([
      'apiKey', 'api_key', 'apikey',
      'token', 'access_token', 'refresh_token', 'id_token',
      'secret', 'client_secret', 'app_secret',
      'password', 'passwd', 'pass',
      'privateKey', 'private_key',
      'auth', 'authorization', 'bearer',
      'credential', 'credentials',
    ]);
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (sensitiveKeys.has(key)) {
        result[key] = '[REDACTED]';
      } else if (value !== null && typeof value === 'object') {
        result[key] = this.scrubSecrets(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Load memory state from disk if present. No-op if no workspaceRoot or missing files. */
  loadFromDisk(): void {
    if (!this.workspaceRoot) return;
    const dir = this.getMemoryDir();
    try {
      const epsPath = path.join(dir, 'episodes.jsonl');
      if (fs.existsSync(epsPath)) {
        const content = fs.readFileSync(epsPath, 'utf-8');
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const ep = JSON.parse(line) as Episode;
            this.memory.episodicMemory.addPersisted(ep);
          } catch { /* skip corrupt lines */ }
        }
      }
      const skillsPath = path.join(dir, 'skills.json');
      if (fs.existsSync(skillsPath)) {
        const skills = JSON.parse(fs.readFileSync(skillsPath, 'utf-8')) as any[];
        for (const s of skills) {
          try { this.memory.proceduralMemory.importSkill(s); } catch { /* skip */ }
        }
      }
      const semanticPath = path.join(dir, 'semantic-nodes.json');
      if (fs.existsSync(semanticPath)) {
        const content = JSON.parse(fs.readFileSync(semanticPath, 'utf-8'));
        if (Array.isArray(content)) {
          this.memory.semanticMemory.importNodes(content);
        } else if (content && typeof content === 'object' && Array.isArray((content as any).nodes)) {
          this.memory.semanticMemory.importNodes((content as any).nodes);
          if (Array.isArray((content as any).edges)) {
            this.memory.semanticMemory.importEdges((content as any).edges);
          }
        }
      }
      const metaPath = path.join(dir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        this.meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      }
    } catch {
      // best-effort load
    }
  }
}
