import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { test, expect, afterEach, vi, describe } from '../harness';
import { EventBus } from '../../src/core/EventBus';
import { PromptOrchestrator, SelfPromptingAgent } from '../../src/core/PromptOrchestrator';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('PromptOrchestrator', () => {
  afterEach(() => {});

  test('registerAgent stores agent and getRegisteredAgents returns role', () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });

    const mockAgent: SelfPromptingAgent = {
      agentId: 'researcher',
      generatePromptFor: async () => 'prompt',
      respondToPrompt: async () => ({ content: 'resp', confidence: 0.9, needsMoreInfo: false }),
      evaluateConversation: async () => 0.9,
    };

    orchestrator.registerAgent(mockAgent);
    const agents = orchestrator.getRegisteredAgents();
    expect(Array.isArray(agents), 'getRegisteredAgents should return array');
    expect(agents.length === 1 && agents[0] === 'researcher', 'registered agent should be researcher');
  });

  test('registerAgent with multiple agents returns all roles', () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });

    const makeAgent = (id: string): SelfPromptingAgent => ({
      agentId: id,
      generatePromptFor: async () => 'prompt',
      respondToPrompt: async () => ({ content: 'resp', confidence: 0.9, needsMoreInfo: false }),
      evaluateConversation: async () => 0.9,
    });

    orchestrator.registerAgent(makeAgent('a'));
    orchestrator.registerAgent(makeAgent('b'));
    orchestrator.registerAgent(makeAgent('c'));

    const agents = orchestrator.getRegisteredAgents();
    expect(agents.length === 3, 'should have 3 agents');
    expect(agents.includes('a'), 'should include a');
    expect(agents.includes('b'), 'should include b');
    expect(agents.includes('c'), 'should include c');
  });

  test('getHistory returns empty array initially', () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });
    const history = orchestrator.getHistory();
    expect(Array.isArray(history), 'history should be array');
    expect(history.length === 0, 'history should be empty initially');
  });

  test('clearHistory resets history to empty', () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });
    orchestrator.clearHistory();
    const history = orchestrator.getHistory();
    expect(history.length === 0, 'history should be empty after clear');
  });

  test('self-prompting loop stops immediately when an agent needs more info', async () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });
    let thirdAgentCalled = 0;

    orchestrator.registerAgent({
      agentId: 'planner',
      generatePromptFor: async () => 'ask for clarification',
      respondToPrompt: async () => ({ content: 'need details', confidence: 0.2, needsMoreInfo: true }),
      evaluateConversation: async () => 0.2,
    });
    orchestrator.registerAgent({
      agentId: 'coder',
      generatePromptFor: async () => 'respond with details',
      respondToPrompt: async () => ({ content: 'unused', confidence: 0.9, needsMoreInfo: true }),
      evaluateConversation: async () => 0.9,
    });
    orchestrator.registerAgent({
      agentId: 'verifier',
      generatePromptFor: async () => 'should never be reached',
      respondToPrompt: async () => {
        thirdAgentCalled++;
        return { content: 'unused', confidence: 0.9, needsMoreInfo: false };
      },
      evaluateConversation: async () => 0.9,
    });

    const result = await orchestrator.runSelfPromptingLoop('build landing page', 'planner');

    expect(result.stopReason === 'needs_more_info', 'loop should stop with an explicit stop reason');
    expect(result.converged === false, 'needs-more-info should not count as convergence');
    expect(result.rounds === 1, 'loop should stop after the first agent asks for more info');
    expect(thirdAgentCalled === 0, 'subsequent agents should not run once more info is needed');
  });

  test('self-prompting loop pauses when self-evaluation confidence is too low', async () => {
    const bus = new EventBus();
    const orchestrator = new PromptOrchestrator({ eventBus: bus, maxRounds: 3, convergenceThreshold: 0.8 });
    let followerCalled = 0;

    orchestrator.registerAgent({
      agentId: 'planner',
      generatePromptFor: async () => 'draft a plan',
      respondToPrompt: async () => ({ content: 'maybe', confidence: 0.9, needsMoreInfo: false }),
      evaluateConversation: async () => 0.9,
    });
    orchestrator.registerAgent({
      agentId: 'coder',
      generatePromptFor: async () => 'continue',
      respondToPrompt: async () => ({ content: 'unused', confidence: 0.9, needsMoreInfo: false }),
      evaluateConversation: async () => 0.4,
    });
    orchestrator.registerAgent({
      agentId: 'verifier',
      generatePromptFor: async () => 'should never be reached',
      respondToPrompt: async () => {
        followerCalled++;
        return { content: 'unused', confidence: 0.9, needsMoreInfo: false };
      },
      evaluateConversation: async () => 0.9,
    });

    const result = await orchestrator.runSelfPromptingLoop('build landing page', 'planner');

    expect(result.stopReason === 'needs_more_info', 'low confidence should pause the loop');
    expect(result.converged === false, 'low confidence should not count as convergence');
    expect(result.rounds === 1, 'loop should stop after the low-confidence response');
    expect(followerCalled === 0, 'later agents should not run after low confidence');
  });
});
