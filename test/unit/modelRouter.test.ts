import * as path from 'path';
import { test, expect } from '../harness';
import { ModelRouter } from '../../src/routing/ModelRouter';
import { FreeModelCapabilityRegistry } from '../../src/routing/ModelCapabilityRegistry';

const repoRoot = path.resolve(__dirname, '..', '..');

test('A1 openrouter researcher route avoids dead slug', () => {
  const router = new ModelRouter('free', repoRoot);
  router.setPreferredProvider('openrouter');
  const apiKeys: Record<string, string> = {
    openrouter: 'k',
    'kilo-gateway': '',
    codik: '',
    ollama: '',
  };
  const sel = router.route({ phase: 'research', agentRole: 'researcher', complexity: 'medium' }, apiKeys);
  expect(sel.provider === 'openrouter', `provider should be openrouter, got ${sel.provider}`);
  expect(
    !sel.modelId.includes('gemini-2.0-flash-exp:free'),
    `modelId must not contain dead slug gemini-2.0-flash-exp:free (got ${sel.modelId})`
  );
});

test('A2 kilo-gateway researcher resolves to a model', () => {
  const router = new ModelRouter('free', repoRoot);
  router.setPreferredProvider('kilo-gateway');
  const apiKeys: Record<string, string> = {
    openrouter: '',
    'kilo-gateway': 'k',
    codik: '',
    ollama: '',
  };
  const sel = router.route({ phase: 'research', agentRole: 'researcher', complexity: 'medium' }, apiKeys);
  expect(sel.provider === 'kilo-gateway', `provider should be kilo-gateway, got ${sel.provider}`);
  expect(sel.modelId.length > 0, `modelId should not be empty (got ${sel.modelId})`);
});

test('A2b smart-free rotates free candidate chain across keyed providers', () => {
  const router = new ModelRouter('free', repoRoot);
  router.setPreferredProvider('openrouter');
  router.setApiKeys({
    openrouter: 'k',
    'kilo-gateway': 'k',
    codik: '',
    ollama: '',
  });

  const coderChain = router.getCandidateChain('coder');
  const researcherChain = router.getCandidateChain('researcher');

  expect(coderChain.length > 0 && researcherChain.length > 0, 'candidate chains should not be empty');
  expect(coderChain[0].provider === 'kilo-gateway', `coder chain should start on kilo-gateway, got ${coderChain[0].provider}`);
  expect(researcherChain[0].provider === 'openrouter', `researcher chain should start on openrouter, got ${researcherChain[0].provider}`);
  expect(coderChain.some((c) => c.provider === 'kilo-gateway' || c.provider === 'openrouter'), 'smart-free chain should stay within keyed providers');
});

test('A3 no-key case falls back to preferred provider', () => {
  const router = new ModelRouter('free', repoRoot);
  router.setPreferredProvider('openrouter');
  const apiKeys: Record<string, string> = {
    openrouter: '',
    'kilo-gateway': '',
    codik: '',
    ollama: '',
  };
  const sel = router.route({ phase: 'research', agentRole: 'researcher', complexity: 'medium' }, apiKeys);
  expect(sel.provider === 'openrouter', `no-key case should fall back to preferred openrouter, got ${sel.provider}`);
});
