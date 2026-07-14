import * as crypto from 'crypto';
import { generateHashEmbedding, cosineSimilarity } from './vectorUtils';

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: 'tool' | 'pattern' | 'workflow' | 'strategy';
  successRate: number;
  usageCount: number;
  lastUsed: number;
  createdAt: number;
  metadata: Record<string, any>;
  embeddings?: number[]; // For semantic similarity
}

export interface SkillExecution {
  skillId: string;
  timestamp: number;
  success: boolean;
  durationMs: number;
  context: Record<string, any>;
  outcome: any;
}

export interface SkillMatch {
  skill: Skill;
  score: number;
  reason: string;
}

export interface ProceduralMemoryConfig {
  maxSkills: number;
  successRateThreshold: number;
  decayFactor: number;
  enableSemanticSearch: boolean;
}

export class ProceduralMemory {
  private skills: Map<string, Skill>;
  private executions: SkillExecution[];
  private config: ProceduralMemoryConfig;

  constructor(config?: Partial<ProceduralMemoryConfig>) {
    this.skills = new Map();
    this.executions = [];
    this.config = {
      maxSkills: 1000,
      successRateThreshold: 0.7,
      decayFactor: 0.95,
      enableSemanticSearch: false,
      ...config,
    };
  }

  registerSkill(skill: Omit<Skill, 'id' | 'createdAt' | 'successRate' | 'usageCount' | 'lastUsed'>): string {
    const id = this.generateSkillId(skill.name, skill.category);
    const newSkill: Skill = {
      id,
      ...skill,
      successRate: 1.0,
      usageCount: 0,
      lastUsed: 0,
      createdAt: Date.now(),
    };

    // Evict if at capacity
    if (this.skills.size >= this.config.maxSkills) {
      this.evictLeastUsed();
    }

    this.skills.set(id, newSkill);
    return id;
  }

  recordExecution(skillId: string, execution: Omit<SkillExecution, 'skillId' | 'timestamp'>): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    const fullExecution: SkillExecution = {
      skillId,
      timestamp: Date.now(),
      ...execution,
    };

    this.executions.push(fullExecution);

    // Update skill metrics
    skill.usageCount++;
    skill.lastUsed = Date.now();

    // Recalculate success rate with decay
    this.updateSuccessRate(skill);

    // Keep only last 1000 executions
    if (this.executions.length > 1000) {
      this.executions = this.executions.slice(-1000);
    }
  }

  findBestSkill(
    query: string,
    category?: Skill['category'],
    context?: Record<string, any>
  ): SkillMatch | null {
    return this.rankSkills(query, category, context, 1)[0] ?? null;
  }

  findTopSkills(
    query: string,
    category?: Skill['category'],
    limit = 3,
    context?: Record<string, any>
  ): SkillMatch[] {
    return this.rankSkills(query, category, context, limit);
  }

  private rankSkills(
    query: string,
    category?: Skill['category'],
    context?: Record<string, any>,
    limit?: number
  ): SkillMatch[] {
    const candidates = Array.from(this.skills.values()).filter(skill => {
      if (category && skill.category !== category) return false;
      if (skill.successRate < this.config.successRateThreshold) return false;
      return true;
    });

    if (candidates.length === 0) return [];

    const matches = candidates.map(skill => ({
      skill,
      score: this.calculateMatchScore(skill, query, context),
      reason: this.generateMatchReason(skill, query),
    }));

    matches.sort((a, b) => b.score - a.score);
    return typeof limit === 'number' ? matches.slice(0, limit) : matches;
  }

  findSkillsByCategory(category: Skill['category']): Skill[] {
    return Array.from(this.skills.values())
      .filter(skill => skill.category === category)
      .sort((a, b) => b.successRate - a.successRate);
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  importSkill(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkillExecutions(skillId: string): SkillExecution[] {
    return this.executions.filter(e => e.skillId === skillId);
  }

  updateSkill(id: string, updates: Partial<Omit<Skill, 'id' | 'createdAt'>>): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;

    Object.assign(skill, updates);
    return true;
  }

  removeSkill(id: string): boolean {
    return this.skills.delete(id);
  }

  private generateSkillId(name: string, category: Skill['category']): string {
    const hash = crypto.createHash('sha256').update(`${category}:${name}`).digest('hex').substring(0, 8);
    return `skill_${hash}`;
  }

  private updateSuccessRate(skill: Skill): void {
    const skillExecutions = this.executions.filter(e => e.skillId === skill.id);
    if (skillExecutions.length === 0) return;

    // Calculate weighted success rate with decay
    let weightedSuccess = 0;
    let totalWeight = 0;

    for (let i = skillExecutions.length - 1; i >= 0; i--) {
      const exec = skillExecutions[i];
      const age = Date.now() - exec.timestamp;
      const weight = Math.pow(this.config.decayFactor, age / (1000 * 60 * 60)); // Decay per hour

      weightedSuccess += (exec.success ? 1 : 0) * weight;
      totalWeight += weight;
    }

    skill.successRate = totalWeight > 0 ? weightedSuccess / totalWeight : skill.successRate;
  }

  private calculateMatchScore(skill: Skill, query: string, context?: Record<string, any>): number {
    let score = 0;

    // Factor 1: Success rate (40%)
    score += skill.successRate * 0.4;

    // Factor 2: Recency (20%)
    const daysSinceLastUse = (Date.now() - skill.lastUsed) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceLastUse / 30); // Decay over 30 days
    score += recencyScore * 0.2;

    // Factor 3: Usage frequency (15%)
    const frequencyScore = Math.min(1, skill.usageCount / 100);
    score += frequencyScore * 0.15;

    // Factor 4: Semantic similarity (15%) - if enabled
    if (this.config.enableSemanticSearch && skill.embeddings) {
      const queryEmbedding = generateHashEmbedding(query);
      const similarity = cosineSimilarity(skill.embeddings, queryEmbedding);
      score += similarity * 0.15;
    } else {
      // Fallback to keyword matching
      const keywordScore = this.keywordMatch(skill.name + ' ' + skill.description, query);
      score += keywordScore * 0.15;
    }

    // Factor 5: Context relevance (10%)
    if (context) {
      const contextScore = this.contextMatch(skill.metadata, context);
      score += contextScore * 0.1;
    }

    return score;
  }

  private keywordMatch(text: string, query: string): number {
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    let matches = 0;
    for (const word of queryWords) {
      if (textLower.includes(word)) matches++;
    }

    return matches / queryWords.length;
  }

  private contextMatch(metadata: Record<string, any>, context: Record<string, any>): number {
    let matches = 0;
    let total = 0;

    for (const key in context) {
      total++;
      if (metadata[key] === context[key]) {
        matches++;
      }
    }

    return total > 0 ? matches / total : 0;
  }

  private generateMatchReason(skill: Skill, query: string): string {
    const reasons: string[] = [];

    if (skill.successRate >= 0.8) {
      reasons.push(`High success rate (${(skill.successRate * 100).toFixed(0)}%)`);
    }

    const daysSinceLastUse = (Date.now() - skill.lastUsed) / (1000 * 60 * 60 * 24);
    if (daysSinceLastUse < 7) {
      reasons.push('Recently used');
    }

    if (skill.usageCount > 10) {
      reasons.push(`Frequently used (${skill.usageCount} times)`);
    }

    if (this.keywordMatch(skill.name + ' ' + skill.description, query) > 0.5) {
      reasons.push('Keyword match');
    }

    return reasons.join(', ') || 'General match';
  }

  private evictLeastUsed(): void {
    let leastUsedSkill: Skill | null = null;
    let lowestUsage = Infinity;

    for (const skill of this.skills.values()) {
      if (skill.usageCount < lowestUsage) {
        lowestUsage = skill.usageCount;
        leastUsedSkill = skill;
      }
    }

    if (leastUsedSkill) {
      this.skills.delete(leastUsedSkill.id);
    }
  }

  getStats(): {
    totalSkills: number;
    totalExecutions: number;
    averageSuccessRate: number;
    topSkills: Skill[];
    byCategory: Record<string, number>;
  } {
    const skills = Array.from(this.skills.values());
    const averageSuccessRate = skills.length > 0
      ? skills.reduce((sum, s) => sum + s.successRate, 0) / skills.length
      : 0;

    const byCategory: Record<string, number> = {};
    for (const skill of skills) {
      byCategory[skill.category] = (byCategory[skill.category] || 0) + 1;
    }

    const topSkills = [...skills]
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 5);

    return {
      totalSkills: skills.length,
      totalExecutions: this.executions.length,
      averageSuccessRate,
      topSkills,
      byCategory,
    };
  }

  clear(): void {
    this.skills.clear();
    this.executions = [];
  }

  getConfig(): ProceduralMemoryConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ProceduralMemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
