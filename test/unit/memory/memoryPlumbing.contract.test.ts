/**
 * L0 memory plumbing contracts (no network).
 *
 * These tests lock in the *real* data path end-to-end using the actual
 * MemoryFacade, ContextAgent, ContextEnrichPhase and AgentRuntime — NOT mocks of
 * enrich(). Mocked tests only prove "the LLM is wired"; they let a regression
 * sneak in where enrich() writes a chat message but the contextPacket stays empty,
 * or where the coder path never records into shared memory.
 *
 * Constraints (contract 3.4):
 *   - NO real OpenRouter / embedding API / Docker / external fetch.
 *   - Only FakeModelRouter, hash embeddings (generateHashEmbedding), tmp fs, vitest.
 *   - Live/network tests live separately under test/live/ behind an opt-in env key.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, expect, it, afterEach, vi } from 'vitest';

import { MemoryFacade } from '../../../src/memory/MemoryFacade';
import { ContextAgent } from '../../../src/agents/ContextAgent';
import { ContextEnrichPhase } from '../../../src/pipeline/phases/ContextEnrichPhase';
import { AgentRuntime } from '../../../src/core/AgentRuntime';
import { ToolRegistry, ToolDefinition } from '../../../src/core/ToolRegistry';
import { EventBus } from '../../../src/core/EventBus';
import { WorkingMemory } from '../../../src/memory/WorkingMemory';
import { FakeModelRouter } from '../../fixtures/FakeModelRouter';
import { generateHashEmbedding } from '../../../src/memory/vectorUtils';
import type { PipelineContext, PipelineHost, PipelineServices } from '../../../src/pipeline/types';
import type { ContextPacket } from '../../../src/shared/types';

// ─── helpers ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-L0-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) {
    try { MemoryFacade.destroyInstance(d); } catch { /* ignore */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function makeContextPacket(goal: string): ContextPacket {
  return {
    taskId: 'task-L0',
    goal,
    workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
  };
}

function makePipelineContext(goal: string): PipelineContext {
  return {
    taskId: 'task-L0',
    rawGoal: goal,
    refinedGoal: goal,
    workspace: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
    goalPacket: { taskId: 'task-L0', intent: 'build', complexity: 'low', goal, workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] } },
    tier: 'LOW',
    phases: ['context-enrich'],
    artifacts: [],
    contextPacket: makeContextPacket(goal),
  } as PipelineContext;
}

// ─── 3.1 Enrich → packet contains memoryContext ─────────────────────────────

describe('L0 memory plumbing — 3.1 enrich reaches contextPacket.memoryContext', () => {
  it('seeds memory, runs ContextEnrichPhase, and populates ctx.contextPacket.memoryContext', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root, { retrievalLimit: 5 });
    // Seed a real episode whose excerpt overlaps the goal (natural-language recall).
    memory.recordEpisode('tool_result', {
      agentId: 'coder',
      toolName: 'write_file',
      success: true,
      excerpt: 'Built an express api server with user routes',
    }, 0.8);

    const artifactManager = { searchArtifacts: vi.fn(() => []) } as any;
    const contextAgent = new ContextAgent(memory, artifactManager);

    const phase = new ContextEnrichPhase();
    const ctx = makePipelineContext('build express api server');

    const host = {
      workspaceRoot: root,
      emitPhaseLifecycle: vi.fn(),
      chat: vi.fn(),
    } as unknown as PipelineHost;

    // Real WorkingMemory (has setContextPacket) — same role as PipelineServices.memory.
    const workingMemory = new WorkingMemory();
    const services = {
      contextAgent,
      memory: workingMemory,
      sharedMemory: memory,
    } as unknown as PipelineServices;

    await phase.run(host, ctx, services);

    // The plumbing: enrichment must reach the packet as a dedicated field,
    // NOT a prefix in researchSummary.
    expect(ctx.contextPacket).toBeDefined();
    expect(typeof ctx.contextPacket!.memoryContext).toBe('string');
    expect(ctx.contextPacket!.memoryContext).not.toBe('');
    // Must mention something from the seed.
    expect(ctx.contextPacket!.memoryContext).toContain('express');
    expect(ctx.contextPacket!.memoryContext).toContain('Past episodes:');

    // Downstream persistence must have been written too.
    expect(workingMemory.getContextPacket()?.memoryContext).toBe(ctx.contextPacket!.memoryContext);
  });

  it('keeps contextPacket.memoryContext empty when memory has nothing relevant', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root, { retrievalLimit: 5 });
    const artifactManager = { searchArtifacts: vi.fn(() => []) } as any;
    const contextAgent = new ContextAgent(memory, artifactManager);

    const phase = new ContextEnrichPhase();
    const ctx = makePipelineContext('completely unrelated goal xyz');

    const host = { workspaceRoot: root, emitPhaseLifecycle: vi.fn(), chat: vi.fn() } as unknown as PipelineHost;
    const workingMemory = new WorkingMemory();
    const services = { contextAgent, memory: workingMemory, sharedMemory: memory } as unknown as PipelineServices;

    await phase.run(host, ctx, services);

    expect(ctx.contextPacket!.memoryContext).toBeUndefined();
  });
});

// ─── 3.2 AgentRuntime + memory records episode on tool ───────────────────────

describe('L0 memory plumbing — 3.2 AgentRuntime records episode into shared memory', () => {
  it('records a tool_result episode into MemoryFacade when memory is passed', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);

    const fakeTool: ToolDefinition = {
      name: 'noop',
      description: 'a no-op tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    const registry = new ToolRegistry(new EventBus());
    registry.register(fakeTool.name, fakeTool, async () => ({ success: true, output: 'ok', durationMs: 0 }));

    // Router emits ONE tool call, then a final answer (no tool call).
    const router = new FakeModelRouter([
      { toolCalls: [{ name: 'noop', arguments: {} }] },
      { content: 'done' },
    ]);

    const runtime = new AgentRuntime(new EventBus(), router, registry, {
      agentId: 'coder',
      tools: [],
      maxIterations: 3,
      systemPrompt: 'you are a coder',
      workspaceRoot: root,
      memory,
      enableTaskCompass: false,
      apiKeys: {},
    });

    await runtime.run('make a thing', makeContextPacket('make a thing') as any);

    const eps = memory.recentEpisodes('tool_result', 10);
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[0].data.toolName).toBeDefined();
    expect(eps[0].data.toolName).toBe('noop');
    expect(eps[0].data.agentId).toBe('coder');
  });

  it('does NOT record episodes when memory is absent (coder path without shared memory)', async () => {
    const root = tmp();
    const fakeTool: ToolDefinition = {
      name: 'noop',
      description: 'a no-op tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
    };
    const registry = new ToolRegistry(new EventBus());
    registry.register(fakeTool.name, fakeTool, async () => ({ success: true, output: 'ok', durationMs: 0 }));

    const router = new FakeModelRouter([
      { toolCalls: [{ name: 'noop', arguments: {} }] },
      { content: 'done' },
    ]);

    const runtime = new AgentRuntime(new EventBus(), router, registry, {
      agentId: 'coder',
      tools: [],
      maxIterations: 3,
      systemPrompt: 'you are a coder',
      workspaceRoot: root,
      memory: undefined,
      enableTaskCompass: false,
      apiKeys: {},
    });

    await runtime.run('make a thing', makeContextPacket('make a thing') as any);
    expect(runtime.memory).toBeNull();
  });
});

// ─── 3.3 Restart simulation: loadFromDisk → skill found (L1 persistence) ──────
// On L0 this still runs (tmp fs, no network) and must pass; on L1 it is mandatory.

describe('L0/L1 memory persistence — 3.3 restart loadFromDisk finds skill', () => {
  it('persists a skill to disk and finds it after a fresh singleton is created', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.registerSkill({
      name: 'express-api',
      description: 'build express api server with routes',
      category: 'workflow',
      metadata: {},
    });

    // Immediate flush so the test is deterministic (no debounce wait).
    memory.flushToDisk(true);

    // Simulate a VS Code reload killing the in-memory singleton.
    MemoryFacade.destroyInstance(root);
    const memory2 = MemoryFacade.getInstance(root);
    await memory2.loadFromDisk();

    const match = memory2.findBestSkill('build express api');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('express-api');
  });
});

// ─── 3.3b Semantic nodes + edges persistence after restart ────────────────────

describe('L0/L1 memory persistence — 3.3b restart loadFromDisk restores semantic graph', () => {
  it('persists semantic nodes and edges to disk and restores them after restart', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.addKnowledgeNode({ label: 'ServiceA', type: 'concept', properties: { x: 1 } });
    memory.addKnowledgeNode({ label: 'ServiceB', type: 'concept', properties: {} });
    memory.addKnowledgeEdge('ServiceA', 'ServiceB', 'calls');

    memory.flushToDisk(true);

    MemoryFacade.destroyInstance(root);
    const memory2 = MemoryFacade.getInstance(root);
    await memory2.loadFromDisk();

    const found = memory2.semanticSearch('ServiceA', 10);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].label).toBe('ServiceA');

    const raw = memory2.getRawMemory().semanticMemory;
    expect(raw.getAllNodes().length).toBeGreaterThanOrEqual(3);
    expect(raw.getAllEdges().length).toBeGreaterThanOrEqual(1);
    expect(raw.getAllEdges().some(e => e.relation === 'calls')).toBe(true);
  });

  it('restores legacy semantic-nodes.json (array without edges field)', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.addKnowledgeNode({ label: 'LegacyNode', type: 'concept', properties: {} });
    memory.flushToDisk(true);

    const legacyPath = path.join(root, '.omniflow', 'memory', 'semantic-nodes.json');
    const legacyContent = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    fs.writeFileSync(legacyPath, JSON.stringify(legacyContent.nodes), 'utf-8');

    MemoryFacade.destroyInstance(root);
    const memory2 = MemoryFacade.getInstance(root);
    await memory2.loadFromDisk();

    expect(memory2.semanticSearch('LegacyNode').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 3.3c Meta.json load after restart ───────────────────────────────────────

describe('L0/L1 memory persistence — 3.3c meta.json load', () => {
  it('reads meta.json back into memory after loadFromDisk', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.flushToDisk(true);

    const metaPath = path.join(root, '.omniflow', 'memory', 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ version: 1, updatedAt: 42, workspaceId: 'ws-1' }, 'utf-8'));

    MemoryFacade.destroyInstance(root);
    const memory2 = MemoryFacade.getInstance(root);
    await memory2.loadFromDisk();

    expect((memory2 as any).meta).toBeTruthy();
    expect((memory2 as any).meta.workspaceId).toBe('ws-1');
    expect((memory2 as any).meta.updatedAt).toBe(42);
  });
});

// ─── 3.3d Scrub secrets in episodes.jsonl ────────────────────────────────────

describe('L0/L1 memory persistence — 3.3d episode secrets are scrubbed on flush', () => {
  it('redacts sensitive fields in episode data before writing episodes.jsonl', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.recordEpisode('tool_result', {
      agentId: 'coder',
      toolName: 'deploy',
      excerpt: 'deployed ok',
      apiKey: 'super-secret-key',
      password: 'hunter2',
      nested: { token: 'abc', safe: 'visible' },
    }, 0.8);

    memory.flushToDisk(true);

    const epsPath = path.join(root, '.omniflow', 'memory', 'episodes.jsonl');
    const raw = fs.readFileSync(epsPath, 'utf-8');
    const line = JSON.parse(raw.split('\n').filter(Boolean)[0]);

    expect(line.data.apiKey).toBe('[REDACTED]');
    expect(line.data.password).toBe('[REDACTED]');
    expect(line.data.nested.token).toBe('[REDACTED]');
    expect(line.data.nested.safe).toBe('visible');
    expect(line.data.excerpt).toBe('deployed ok');
  });
});

// ─── 3.4 Never require network in unit tests ─────────────────────────────────

describe('L0 memory plumbing — 3.4 offline harness (no network)', () => {
  it('uses deterministic hash embeddings (no embedding API)', () => {
    const a = generateHashEmbedding('build express api');
    const b = generateHashEmbedding('build express api');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // Distinct inputs must not collide completely.
    expect(generateHashEmbedding('totally different')).not.toEqual(a);
  });

  it('FakeModelRouter answers offline (provider=fake, never contacts a real provider)', async () => {
    const router = new FakeModelRouter([{ content: 'offline' }]);
    const res = await router.call({ phase: 'build', agentRole: 'coder', complexity: 'low' }, 'prompt', 'sys', {}, undefined, []);
    expect(res.provider).toBe('fake');
    expect(res.content).toBe('offline');
  });

  it('episode recall works with zero network (in-memory facade + tmp fs only)', async () => {
    const root = tmp();
    const memory = MemoryFacade.getInstance(root);
    memory.recordEpisode('tool_result', { agentId: 'coder', toolName: 'write_file', excerpt: 'Built an express api server' }, 0.8);
    const res = memory.selectiveRetrieve('express api');
    expect(res.length).toBeGreaterThan(0);
  });
});
