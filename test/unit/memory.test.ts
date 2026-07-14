import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { test, expect, afterEach, describe } from '../harness';

import { EpisodicMemory } from '../../src/memory/EpisodicMemory';
import { HierarchicalMemory } from '../../src/memory/HierarchicalMemory';
import { LedgerMemory } from '../../src/memory/LedgerMemory';
import { MemoryFacade } from '../../src/memory/MemoryFacade';
import { ProceduralMemory } from '../../src/memory/ProceduralMemory';
import { SemanticMemory } from '../../src/memory/SemanticMemory';
import { WorkingMemory } from '../../src/memory/WorkingMemory';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mem-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  dirs.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── EpisodicMemory ─────────────────────────
describe('EpisodicMemory', () => {
  test('add/get/remove/getAll/getByType/size/clear', () => {
    const mem = new EpisodicMemory();
    const ep = mem.add({ type: 'research', data: { q: 'hello' }, importance: 0.8 });
    expect(typeof ep.id === 'string', 'add returns id');
    expect(ep.timestamp > 0, 'add sets timestamp');
    expect(mem.size() === 1, 'size is 1 after add');
    expect(mem.get(ep.id)?.id === ep.id, 'get returns the episode');
    expect(mem.getAll().length === 1, 'getAll returns 1');

    mem.add({ type: 'build', data: { q: 'world' }, importance: 0.5 });
    expect(mem.getByType('research').length === 1, 'getByType filters by type');
    expect(mem.getByType('build').length === 1, 'getByType build');

    expect(mem.remove(ep.id) === true, 'remove returns true');
    expect(mem.size() === 1, 'size is 1 after remove');
    mem.clear();
    expect(mem.size() === 0, 'clear empties memory');
    expect(mem.getAll().length === 0, 'getAll empty after clear');
  });

  test('search finds by type+content and respects minImportance', () => {
    const mem = new EpisodicMemory();
    mem.add({ type: 'research', data: { text: 'authentication token refresh' }, importance: 0.9 });
    mem.add({ type: 'build', data: { text: 'database migration script' }, importance: 0.2 });

    const results = mem.search('authentication token', 10, 0);
    expect(results.length >= 1, 'search returns matches');
    expect(results[0].episode.type === 'research', 'top result is research');
    expect(typeof results[0].score === 'number', 'search result has score');

    const highOnly = mem.search('authentication token', 10, 0.5);
    expect(highOnly.every((r) => r.episode.importance >= 0.5), 'minImportance filters low-importance');
  });

  test('applyDecay reduces strength of older episodes over time', async () => {
    const mem = new EpisodicMemory({ halfLifeMs: 1 });
    const old = mem.add({ type: 'research', data: { a: 1 }, importance: 1.0 });
    await sleep(15);
    const recent = mem.add({ type: 'research', data: { b: 2 }, importance: 1.0 });
    mem.applyDecay();
    expect(old.importance < recent.importance, 'older episode decays more than recent one');
    expect(old.importance < 1.0, 'older episode strength reduced');
  });
});

// ───────────────────────── HierarchicalMemory ─────────────────────────
describe('HierarchicalMemory', () => {
  test('recordEpisode + recentEpisodes', () => {
    const hm = new HierarchicalMemory();
    hm.recordEpisode('planning', { plan: 'x' }, 0.7);
    hm.recordEpisode('planning', { plan: 'y' }, 0.7);
    hm.recordEpisode('build', { done: true }, 0.7);
    expect(hm.recentEpisodes('planning').length === 2, 'recentEpisodes filters by type');
    expect(hm.recentEpisodes('planning', 1).length === 1, 'recentEpisodes limit');
  });

  test('selectiveRetrieve delegates to episodic search', () => {
    const hm = new HierarchicalMemory();
    hm.recordEpisode('research', { text: 'login flow redesign' }, 0.9);
    const res = hm.selectiveRetrieve('login flow');
    expect(res.length >= 1, 'selectiveRetrieve returns results');
  });

  test('registerSkill / findBestSkill', () => {
    const hm = new HierarchicalMemory();
    const id = hm.registerSkill({
      name: 'deploy via ssh',
      description: 'deploys artifacts over ssh',
      category: 'workflow',
      metadata: {},
    });
    expect(typeof id === 'string', 'registerSkill returns id');
    const match = hm.findBestSkill('deploy ssh');
    expect(match !== null, 'findBestSkill returns a match');
    expect(match?.skill.id === id, 'findBestSkill returns registered skill');
  });

  test('findTopSkills returns a ranked shortlist', () => {
    const hm = new HierarchicalMemory();
    hm.registerSkill({ name: 'design landing page', description: 'create landing page layouts', category: 'workflow', metadata: {} });
    hm.registerSkill({ name: 'debug api', description: 'trace server errors', category: 'tool', metadata: {} });
    const matches = hm.findTopSkills('landing page design', undefined, 2);
    expect(matches.length === 2, 'findTopSkills returns a shortlist');
    expect(matches[0].skill.name.includes('landing'), 'top match should be the relevant skill');
  });

  test('semanticSearch / findKnowledgePath / getKnowledgeSubgraph', () => {
    const hm = new HierarchicalMemory();
    hm.addKnowledgeEdge('AuthService', 'TokenManager', 'manages');
    hm.addKnowledgeEdge('TokenManager', 'Database', 'persists');
    const found = hm.semanticSearch('authservice');
    expect(found.length >= 1, 'semanticSearch finds node by keyword');

    const pathRes = hm.findKnowledgePath('AuthService', 'Database');
    expect(pathRes !== null, 'findKnowledgePath finds a path');
    expect(pathRes!.nodes.length === 3, 'path has 3 nodes A-B-C');

    const subgraph = hm.getKnowledgeSubgraph('AuthService');
    expect(subgraph.nodes.length >= 2, 'subgraph includes neighbors');
  });

  test('getDiagnostics + clear', () => {
    const hm = new HierarchicalMemory();
    hm.registerSkill({ name: 's1', description: 'd', category: 'tool', metadata: {} });
    hm.addKnowledgeNode({ label: 'X', type: 'concept', properties: {} });
    const diag = hm.getDiagnostics();
    expect(diag.proceduralMemory.skillCount === 1, 'diagnostics report skill count');
    expect(diag.semanticMemory.nodeCount === 1, 'diagnostics report node count');
    hm.clear();
    expect(hm.getDiagnostics().episodicMemory.episodeCount === 0, 'clear empties episodic');
  });
});

// ───────────────────────── LedgerMemory ─────────────────────────
describe('LedgerMemory', () => {
  test('append / getEntries / getLedgerPath and persistence', () => {
    const root = tmp();
    const mem = new LedgerMemory(root);
    mem.append({ type: 'phase_transition', data: { from: 'a', to: 'b' } });
    mem.append({ type: 'artifact_created', data: { path: '/x' } });

    expect(mem.getEntries().length === 2, 'getEntries returns appended entries');
    expect(mem.getLedgerPath().endsWith('ledger.jsonl'), 'ledger path ends with ledger.jsonl');

    const reloaded = new LedgerMemory(root);
    expect(reloaded.getEntries().length === 2, 'fresh instance loads persisted entries');
    expect(reloaded.getEntries()[0].type === 'phase_transition', 'persisted content preserved');
  });
});

// ───────────────────────── MemoryFacade (singleton) ─────────────────────────
describe('MemoryFacade', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) {
      try {
        MemoryFacade.destroyInstance(r);
      } catch {}
    }
    roots.length = 0;
  });

  function facade(): MemoryFacade {
    const root = tmp();
    roots.push(root);
    return MemoryFacade.getInstance(root, { maxPromptMemoryChars: 3200 });
  }

  test('recordEpisode / selectiveRetrieve', () => {
    const f = facade();
    f.recordEpisode('research', { text: 'caching strategy', agentId: 'a1', excerpt: 'use redis' }, 0.8);
    const res = f.selectiveRetrieve('caching');
    expect(res.length >= 1, 'selectiveRetrieve finds recorded episode');
  });

  test('buildMemoryContextBlock returns a string and truncates at cutoff', () => {
    const root = tmp();
    roots.push(root);
    const f = MemoryFacade.getInstance(root, { maxPromptMemoryChars: 40 });
    f.recordEpisode('research', { agentId: 'a1', excerpt: 'excerpt long enough to exceed the small cutoff limit on purpose' }, 0.9);
    const block = f.buildMemoryContextBlock('excerpt');
    expect(typeof block === 'string', 'buildMemoryContextBlock returns string');
    expect(block.includes('relevant memory'), 'block contains header');
    expect(block.includes('(truncated)'), 'block is truncated at small cutoff');
  });

  test('buildMemoryContextBlock respects agentId and excerpt', () => {
    const f = facade();
    f.recordEpisode('research', { agentId: 'agentX', excerpt: 'hello excerpt' }, 0.9);
    const block = f.buildMemoryContextBlock('hello');
    expect(block.includes('[research@agentX]'), 'block includes agent id');
    expect(block.includes('hello excerpt'), 'block includes excerpt');
  });

  test('registerSkill / findBestSkill / semanticSearch / applyDecay / clear / getDiagnostics', () => {
    const f = facade();
    f.registerSkill({ name: 'parse logs', description: 'parse log files', category: 'tool', metadata: {} });
    const match = f.findBestSkill('parse logs');
    expect(match !== null, 'findBestSkill works via facade');
    expect(f.getAllSkills().length === 1, 'getAllSkills returns 1');

    f.addKnowledgeNode({ label: 'Cache', type: 'concept', properties: {} });
    expect(f.semanticSearch('cache').length >= 1, 'semanticSearch via facade works');

    f.recordEpisode('research', { text: 'decay me' }, 0.9);
    expect(() => f.applyDecay(), 'applyDecay does not throw');
    const diag = f.getDiagnostics();
    expect(diag.episodicMemory.episodeCount === 1, 'diagnostics report episodes');

    f.clear();
    expect(f.getDiagnostics().episodicMemory.episodeCount === 0, 'clear empties facade');
  });

  test('buildMemoryContextBlock includes top skill matches when relevant', () => {
    const f = facade();
    f.registerSkill({ name: 'plan rollout', description: 'turn goals into phased plans', category: 'workflow', metadata: {} });
    f.registerSkill({ name: 'ship safely', description: 'verify before delivery', category: 'strategy', metadata: {} });
    const block = f.buildMemoryContextBlock('phased rollout plan');
    expect(block.includes('relevant skills'), 'block should include a skills section');
    expect(block.includes('plan rollout'), 'block should surface the matching skill');
  });

  test('getInstance is a singleton ignoring later config', () => {
    const root = tmp();
    roots.push(root);
    const a = MemoryFacade.getInstance(root, { maxPromptMemoryChars: 10 });
    const b = MemoryFacade.getInstance(root);
    expect(a === b, 'getInstance returns the same instance');
  });
});

// ───────────────────────── ProceduralMemory ─────────────────────────
describe('ProceduralMemory', () => {
  test('registerSkill / duplicate name overwrites (same id)', () => {
    const pm = new ProceduralMemory();
    const id1 = pm.registerSkill({ name: 'deploy', description: 'd', category: 'workflow', metadata: {} });
    const id2 = pm.registerSkill({ name: 'deploy', description: 'updated', category: 'workflow', metadata: {} });
    expect(id1 === id2, 'duplicate name+category yields identical id (overwrites, no throw)');
    expect(pm.getAllSkills().length === 1, 'only one skill stored');
  });

  test('recordExecution updates usage and successRate; low success drops below threshold', () => {
    const pm = new ProceduralMemory();
    const id = pm.registerSkill({ name: 'build pkg', description: 'builds package', category: 'tool', metadata: {} });
    pm.recordExecution(id, { success: true, durationMs: 10, context: {}, outcome: {} });
    expect(pm.getSkillExecutions(id).length === 1, 'getSkillExecutions returns executions');
    expect(pm.getSkill(id)!.usageCount === 1, 'usageCount incremented');

    // 1 success + 1 failure with equal weights => successRate ~0.5 (< 0.7 threshold)
    pm.recordExecution(id, { success: false, durationMs: 10, context: {}, outcome: {} });
    expect(pm.getSkill(id)!.successRate < 0.7, 'failed execution drops successRate below threshold');
    expect(pm.findBestSkill('build pkg') === null, 'skill below threshold is not returned by findBestSkill');
  });

  test('findBestSkill scoring prefers keyword-relevant skill', () => {
    const pm = new ProceduralMemory();
    pm.registerSkill({ name: 'deploy via ssh', description: 'deploy over ssh', category: 'workflow', metadata: {} });
    pm.registerSkill({ name: 'analyze logs', description: 'analyze log files', category: 'workflow', metadata: {} });
    const m = pm.findBestSkill('deploy ssh tunnel');
    expect(m !== null, 'findBestSkill returns a match');
    expect(m!.skill.name.includes('deploy'), 'matched the deploy-related skill by keyword');
  });

  test('updateSkill / removeSkill / getStats / config', () => {
    const pm = new ProceduralMemory({ maxSkills: 5 });
    const id = pm.registerSkill({ name: 's', description: 'd', category: 'tool', metadata: {} });
    expect(pm.updateSkill(id, { description: 'updated' }) === true, 'updateSkill returns true');
    expect(pm.getSkill(id)!.description === 'updated', 'skill description updated');
    expect(pm.removeSkill(id) === true, 'removeSkill returns true');
    expect(pm.getSkill(id) === undefined, 'skill removed');

    const stats = pm.getStats();
    expect(stats.totalSkills === 0, 'stats reflect removed skill');
    expect(stats.byCategory && typeof stats.byCategory === 'object', 'stats byCategory is a record');

    expect(pm.getConfig().maxSkills === 5, 'getConfig returns configured value');
    pm.updateConfig({ maxSkills: 9 });
    expect(pm.getConfig().maxSkills === 9, 'updateConfig updates value');

    pm.registerSkill({ name: 's2', description: 'd', category: 'tool', metadata: {} });
    pm.clear();
    expect(pm.getAllSkills().length === 0, 'clear empties skills');
  });
});

// ───────────────────────── SemanticMemory ─────────────────────────
describe('SemanticMemory', () => {
  test('addNode / getNode / addEdge auto-creates relation nodes', () => {
    const sm = new SemanticMemory();
    const nid = sm.addNode({ label: 'ServiceA', type: 'concept', properties: { x: 1 } });
    expect(typeof nid === 'string', 'addNode returns id');
    expect(sm.getNode(nid)?.label === 'ServiceA', 'getNode returns node');

    const eid = sm.addEdge('ServiceA', 'ServiceB', 'calls');
    expect(typeof eid === 'string', 'addEdge returns id');
    // addEdge implicitly creates both endpoints as 'relation' nodes
    expect(sm.findNode('ServiceB', 'relation') !== undefined, 'target node auto-created as relation');
    expect(sm.findNode('ServiceA', 'relation') !== undefined, 'source node auto-created as relation');
  });

  test('findPath reachability A-B-C', () => {
    const sm = new SemanticMemory();
    sm.addEdge('A', 'B', 'next');
    sm.addEdge('B', 'C', 'next');
    const path = sm.findPath('A', 'C');
    expect(path !== null, 'path exists A->C');
    expect(path!.nodes.length === 3, 'path has 3 nodes');
    expect(path!.edges.length === 2, 'path has 2 edges');
    expect(sm.findPath('A', 'Z') === null, 'path null when unreachable');
  });

  test('semanticSearch keyword fallback', () => {
    const sm = new SemanticMemory();
    sm.addNode({ label: 'AuthenticationService', type: 'concept', properties: {} });
    const res = sm.semanticSearch('authentication', 10);
    expect(res.length >= 1, 'semanticSearch finds by keyword');
    expect(res[0].label === 'AuthenticationService', 'returns the matching node');
  });

  test('getSubgraph returns neighborhood', () => {
    const sm = new SemanticMemory();
    sm.addEdge('A', 'B', 'rel');
    sm.addEdge('B', 'C', 'rel');
    const sub = sm.getSubgraph('A', 2);
    expect(sub.nodes.length === 3, 'subgraph includes 3 nodes within radius 2');
    expect(sub.edges.length === 2, 'subgraph includes 2 edges');
  });

  test('removeNode / removeEdge keep adjacency consistent', () => {
    const sm = new SemanticMemory();
    const eid = sm.addEdge('A', 'B', 'rel');
    const aId = sm.findNode('A', 'relation')!.id;
    const bId = sm.findNode('B', 'relation')!.id;
    expect(sm.removeEdge(eid) === true, 'removeEdge returns true');
    expect(sm.removeEdge(eid) === false, 'removeEdge again returns false');
    expect(sm.getNeighbors(bId).every((n) => n.id !== aId), 'adjacency updated after edge removal');

    expect(sm.removeNode(aId) === true, 'removeNode returns true');
    expect(sm.getNode(aId) === undefined, 'node removed');
  });

  test('getStats / clear', () => {
    const sm = new SemanticMemory();
    sm.addNode({ label: 'N1', type: 'concept', properties: {} });
    sm.addEdge('N1', 'N2', 'rel');
    const stats = sm.getStats();
    expect(stats.totalNodes >= 2, 'stats total nodes');
    expect(stats.totalEdges === 1, 'stats total edges');
    sm.clear();
    expect(sm.getStats().totalNodes === 0, 'clear empties nodes');
  });
});

// ───────────────────────── WorkingMemory ─────────────────────────
describe('WorkingMemory', () => {
  test('set/get packet methods', () => {
    const wm = new WorkingMemory();
    wm.setGoalPacket({ goal: 'g' } as any);
    wm.setResearchReport({ summary: 'r' } as any);
    wm.setExecutionPlan({ steps: [] } as any);
    wm.setContextPacket({ ctx: 1 } as any);
    wm.setArtifactManifest({ items: [] } as any);
    wm.setSecurityReport({ risk: 'low' } as any);
    expect(wm.getGoalPacket()?.goal === 'g', 'goal packet round-trips');
    expect(wm.getResearchReport()?.summary === 'r', 'research report round-trips');
    expect(wm.getExecutionPlan()?.steps !== undefined, 'execution plan round-trips');
    expect(wm.getContextPacket()?.ctx === 1, 'context packet round-trips');
    expect(wm.getArtifactManifest()?.items !== undefined, 'artifact manifest round-trips');
    expect(wm.getSecurityReport()?.risk === 'low', 'security report round-trips');
    wm.clear();
    expect(wm.getGoalPacket() === null, 'clear nulls goal packet');
  });

  test('recordEpisode / searchEpisodes no-op without injected episodic memory', () => {
    const wm = new WorkingMemory();
    wm.recordEpisode('research', { a: 1 }, 0.5);
    expect(wm.searchEpisodes('a').length === 0, 'searchEpisodes no-ops when episodic memory unset');
  });

  test('recordEpisode / searchEpisodes work with injected episodic memory', () => {
    const wm = new WorkingMemory();
    const em = new EpisodicMemory();
    wm.setHierarchicalEpisodicMemory(em);
    wm.recordEpisode('research', { text: 'needle in haystack' }, 0.9);
    const res = wm.searchEpisodes('needle');
    expect(res.length >= 1, 'searchEpisodes returns injected episodes');
    expect(wm.getHierarchicalEpisodicMemory() === em, 'injected memory retrievable');
  });
});
