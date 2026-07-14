import { test, expect, afterEach } from '../harness';
import { DynamicPromptBuilder } from '../../src/core/DynamicPromptBuilder';
import { LayeredPromptBuilder, createDefaultPromptBuilder } from '../../src/core/LayeredPromptBuilder';
import type { AgentMessage, PromptTemplate } from '../../src/core/DynamicPromptBuilder';

// DynamicPromptBuilder tests
const builder = new DynamicPromptBuilder();

test('DPB1 registerTemplate then getTemplate returns it', () => {
  const tpl: PromptTemplate = { base: 'Hello', contextInjectors: [], outputRequirements: [] };
  builder.registerTemplate('custom', tpl);
  expect(builder.getTemplate('custom') === tpl, 'getTemplate should return registered template');
});

test('DPB2 hasTemplate true after registration', () => {
  const tpl: PromptTemplate = { base: 'x', contextInjectors: [], outputRequirements: [] };
  builder.registerTemplate('exists', tpl);
  expect(builder.hasTemplate('exists') === true, 'hasTemplate should be true');
});

test('DPB3 buildPrompt returns a string containing goal/role', () => {
  builder.registerTemplate('tpl', { base: 'You are a {role}.', contextInjectors: [], outputRequirements: [] });
  const out = builder.buildPrompt('tpl', { agentRole: 'planner', currentGoal: 'Build API', conversationHistory: [] });
  expect(typeof out === 'string', 'buildPrompt should return a string');
  expect(out.includes('API'), 'prompt should include the goal');
});

test('DPB4 buildFallbackPrompt returns a string', () => {
  expect(typeof builder.buildPrompt('unknown_role', { agentRole: 'ninja', currentGoal: 'Do things', conversationHistory: [] }) === 'string', 'fallback should return string');
});

test('DPB5 buildSelfPromptingPrompt returns a string', () => {
  const out = builder.buildSelfPromptingPrompt('planner', 'coder', 'Build X', []);
  expect(typeof out === 'string', 'self-prompting prompt should be a string');
  expect(out.includes('planner') && out.includes('coder'), 'should mention both agent names');
});

test('DPB6 registering then overwriting a template', () => {
  const tpl1: PromptTemplate = { base: 'V1', contextInjectors: [], outputRequirements: [] };
  const tpl2: PromptTemplate = { base: 'V2', contextInjectors: [], outputRequirements: [] };
  builder.registerTemplate('overwrite', tpl1);
  builder.registerTemplate('overwrite', tpl2);
  const got = builder.getTemplate('overwrite');
  expect(got !== undefined && got.base === 'V2', 'second registration should overwrite the first');
});

// LayeredPromptBuilder tests
test('LPB1 addLayer increments getLayers length', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'a', content: 'content a', priority: 10 });
  expect(b.getLayers().length === 1, 'one layer should exist');
});

test('LPB2 addLayer sorts by priority descending', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'low', content: 'low', priority: 1 });
  b.addLayer({ name: 'high', content: 'high', priority: 100 });
  const names = b.getLayers().map(l => l.name);
  expect(names[0] === 'high', 'higher priority should come first');
});

test('LPB3 removeLayer removes by name', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'keep', content: 'x', priority: 1 });
  b.addLayer({ name: 'remove', content: 'y', priority: 1 });
  b.removeLayer('remove');
  expect(b.getLayers().length === 1, 'only keep should remain');
  expect(b.getLayers()[0].name === 'keep', 'the kept layer should be present');
});

test('LPB4 clear empties layers', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'a', content: 'x', priority: 1 });
  b.clear();
  expect(b.getLayers().length === 0, 'layers should be empty after clear');
});

test('LPB5 build returns string with layer content', () => {
  const b = createDefaultPromptBuilder();
  const ctx = { agentId: 'a', phase: 'build', goal: 'Add feature' };
  const out = b.build(ctx);
  expect(typeof out === 'string', 'build should return string');
  expect(out.includes('AI coding assistant'), 'should include base layer content');
});

test('LPB6 buildSystemPrompt appends goal', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'sys', content: 'You are helpful.', priority: 100 });
  const out = b.buildSystemPrompt({ agentId: 'a', phase: 'planning', goal: 'Plan feature' } as any);
  expect(out.includes('You are helpful.'), 'system prompt should include layer content');
  expect(out.includes('Plan feature'), 'system prompt should append current task/goal');
});

test('LPB7 buildSystemPrompt adds a language directive for non-English goals', () => {
  const b = new LayeredPromptBuilder();
  b.addLayer({ name: 'sys', content: 'You are helpful.', priority: 100 });
  const out = b.buildSystemPrompt({ agentId: 'a', phase: 'planning', goal: 'Сделай лендинг' } as any);
  expect(out.includes('Respond in Russian'), 'system prompt should preserve the user language');
});

test('LPB8 buildUserPrompt with workspaceSnapshot includes fileTree', () => {
  const b = new LayeredPromptBuilder();
  const ctx = { agentId: 'a', phase: 'build', goal: 'Do it', workspaceSnapshot: { fileTree: ['a.ts', 'b.ts'] } as any };
  const out = b.buildUserPrompt(ctx);
  expect(out.includes('a.ts'), 'user prompt should include fileTree when workspaceSnapshot present');
});

test('LPB9 buildUserPrompt without workspaceSnapshot returns empty base', () => {
  const b = new LayeredPromptBuilder();
  const ctx = { agentId: 'a', phase: 'build', goal: 'Do it' } as any;
  const out = b.buildUserPrompt(ctx);
  expect(typeof out === 'string', 'output should be string');
});
