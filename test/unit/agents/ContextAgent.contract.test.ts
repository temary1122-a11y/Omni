import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ContextAgent } from '../../../src/agents/ContextAgent';
import type { ContextEnrichment } from '../../../src/agents/ContextAgent';
import type { MemoryFacade } from '../../../src/memory/MemoryFacade';
import type { ArtifactManager } from '../../../src/artifacts/ArtifactManager';
import type { ContextPacket } from '../../../src/shared/types';

describe('ContextAgent.enrich contract', () => {
  let memory: MemoryFacade;
  let artifactManager: ArtifactManager;
  let contextAgent: ContextAgent;
  const goal = 'test goal';

  beforeEach(() => {
    memory = {
      selectiveRetrieve: vi.fn(),
      findBestSkill: vi.fn(),
      semanticSearch: vi.fn(),
    } as unknown as MemoryFacade;
    artifactManager = {
      searchArtifacts: vi.fn(),
    } as unknown as ArtifactManager;
    contextAgent = new ContextAgent(memory, artifactManager);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

it('returns a ContextEnrichment with correct shape and types', async () => {
     // Mock dependencies to return empty arrays/false for deterministic test
     (memory.selectiveRetrieve as any).mockImplementation(() => []);
     (memory.findBestSkill as any).mockImplementation(() => null);
     (memory.semanticSearch as any).mockImplementation(() => []);
     (artifactManager.searchArtifacts as any).mockImplementation(() => []);

     const result: ContextEnrichment = await contextAgent.enrich(goal);

    // Check structure
    expect(result).toHaveProperty('memoryContext');
    expect(typeof result.memoryContext).toBe('string');
    expect(result).toHaveProperty('episodeCount');
    expect(typeof result.episodeCount).toBe('number');
    expect(result).toHaveProperty('skillFound');
    expect(typeof result.skillFound).toBe('boolean');
    expect(result).toHaveProperty('artifactCount');
    expect(typeof result.artifactCount).toBe('number');
    expect(result).toHaveProperty('semanticNodeCount');
    expect(typeof result.semanticNodeCount).toBe('number');

    // Since we mocked everything to return empty/false, we expect:
    expect(result.memoryContext).toBe(''); // empty string when no data
    expect(result.episodeCount).toBe(0);
    expect(result.skillFound).toBe(false);
    expect(result.artifactCount).toBe(0);
    expect(result.semanticNodeCount).toBe(0);
  });

  it('includes episodic memory when present', async () => {
    const mockEpisodes = [
      {
        episode: { type: 'agent_action', data: { agentId: 'coder', excerpt: 'wrote function foo' } },
        similarity: 0.8,
      },
    ];
    (memory.selectiveRetrieve as any).mockImplementation(() => mockEpisodes);
    (memory.findBestSkill as any).mockImplementation(() => null);
    (memory.semanticSearch as any).mockImplementation(() => []);
    (artifactManager.searchArtifacts as any).mockImplementation(() => []);

    const result = await contextAgent.enrich(goal);

    expect(result.episodeCount).toBe(1);
    expect(result.memoryContext).toContain('Past episodes:');
    expect(result.memoryContext).toContain('coder');
    expect(result.memoryContext).toContain('wrote function foo');
  });

  it('includes skill when found', async () => {
    (memory.selectiveRetrieve as any).mockImplementation(() => []);
    (memory.findBestSkill as any).mockImplementation(() => ({
      score: 0.8,
      skill: { name: 'test-skill', description: 'a test skill', successRate: 0.9 },
    }));
    (memory.semanticSearch as any).mockImplementation(() => []);
    (artifactManager.searchArtifacts as any).mockImplementation(() => []);

    const result = await contextAgent.enrich(goal);

    expect(result.skillFound).toBe(true);
    expect(result.memoryContext).toContain('Recalled skill:');
    expect(result.memoryContext).toContain('test-skill');
    expect(result.memoryContext).toContain('90% success');
  });

it('includes artifacts when found', async () => {
    (memory.selectiveRetrieve as any).mockImplementation(() => []);
    (memory.findBestSkill as any).mockImplementation(() => null);
    (memory.semanticSearch as any).mockImplementation(() => []);
    (artifactManager.searchArtifacts as any).mockImplementation(() => [
      { filePath: 'src/test.ts', type: 'code', preview: 'console.log("hello");' },
    ]);

    const result = await contextAgent.enrich(goal);

    expect(result.artifactCount).toBe(1);
    expect(result.memoryContext).toContain('Related artifacts:');
    expect(result.memoryContext).toContain('src/test.ts');
    expect(result.memoryContext).toContain('console.log(\"hello\");');
  });

  it('includes semantic nodes when found', async () => {
    (memory.selectiveRetrieve as any).mockImplementation(() => []);
    (memory.findBestSkill as any).mockImplementation(() => null);
    (memory.semanticSearch as any).mockImplementation(() => [
      { label: 'authentication', type: 'concept' },
    ]);
    (artifactManager.searchArtifacts as any).mockImplementation(() => []);

    const result = await contextAgent.enrich(goal);

    expect(result.semanticNodeCount).toBe(1);
    expect(result.memoryContext).toContain('Known concepts:');
    expect(result.memoryContext).toContain('authentication (concept)');
  });
});