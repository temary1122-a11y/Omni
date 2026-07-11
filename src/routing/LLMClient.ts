import type { ModelSelection } from './ModelRouter';
import { logLLMCall } from './LLMLogger';
import type { AgentRole, Phase } from '../../shared/types';
import { getChatEndpoint } from './providerUtils';

/** Gate verbose per-call diagnostics behind an env flag to keep the console clean. */
const LLM_DEBUG = process.env.OMNI_LLM_DEBUG === '1';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  usedFallback: boolean;
  reasoning?: string;
  /** Native function-calling tool calls returned by the API (OpenAI-compatible). */
  toolCalls?: LLMToolCall[];
  /** Populated when the call failed / fell back; used by routers to decide retry. */
  error?: string;
}

export interface LLMCallContext {
  agentRole: AgentRole;
  phase: Phase;
}

/** HTTP client for OpenRouter / Kilo Gateway / Codik / Ollama-compatible APIs */
export class LLMClient {
  async complete(
    selection: ModelSelection,
    messages: LLMMessage[],
    apiKeys: Record<string, string>,
    context?: LLMCallContext,
    tools?: any[],
    toolChoice: 'auto' | 'none' | { type: 'function'; function: { name: string } } = 'auto'
  ): Promise<LLMResponse> {
    const logContext = context ?? { agentRole: 'orchestrator' as AgentRole, phase: 'intake' as Phase };

    console.log('[LLMClient] complete', selection.provider, selection.modelId);

    if (selection.provider === 'fallback') {
      const response = {
        content: this.fallbackResponse(messages),
        provider: 'fallback',
        model: selection.modelId,
        usedFallback: true,
        reasoning: undefined,
      };
      logLLMCall({
        ...logContext,
        provider: response.provider,
        model: response.model,
        usedFallback: true,
        error: 'provider set to fallback',
      });
      return response;
    }

    const key = apiKeys[selection.provider];
    const needsKey = selection.provider !== 'ollama';
    console.log('[LLMClient] using provider', selection.provider, 'hasKey=' + Boolean(key));

    if (needsKey && !key) {
      const response = {
        content: this.fallbackResponse(messages),
        provider: 'fallback',
        model: 'no-api-key',
        usedFallback: true,
        reasoning: undefined,
      };
      logLLMCall({
        ...logContext,
        provider: response.provider,
        model: response.model,
        usedFallback: true,
        error: `no API key for ${selection.provider}`,
      });
      return response;
    }

    try {
      const url = getChatEndpoint(selection.provider);
      const body: Record<string, unknown> = {
        model: selection.modelId,
        messages,
        max_tokens: selection.maxTokens,
        temperature: 0.2,
      };

      // Native function calling: expose tool schemas to the model when available.
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(selection.provider === 'openrouter'
            ? { 'HTTP-Referer': 'https://omni-vscode-extension', 'X-Title': 'Omni' }
            : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${selection.provider} HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string; thinking?: string; reasoning?: string; tool_calls?: any[] } }[];
      };
      const rawContent = data.choices?.[0]?.message?.content ?? '';
      const message = (data.choices?.[0]?.message ?? {}) as Record<string, unknown>;
      const reasoning = (message.reasoning_content as string | undefined)
        ?? (message.thinking as string | undefined)
        ?? (message.reasoning as string | undefined)
        ?? undefined;
      const content = rawContent || reasoning || '';
      if (LLM_DEBUG) console.log('[LLMClient] Extracted reasoning:', reasoning ? 'present' : 'none');

      // Native tool calls (OpenAI-compatible). Parse each definition's arguments JSON.
      const rawToolCalls = (message.tool_calls as any[] | undefined) ?? [];
      const toolCalls: LLMToolCall[] = [];
      for (const tc of rawToolCalls) {
        if (tc?.type !== 'function' || !tc?.function?.name) continue;
         let args: any = {};
         const raw = tc.function.arguments;
         try {
           if (raw == null || raw === '') {
             args = {};
           } else if (typeof raw === 'object') {
             args = raw;
           } else {
             args = JSON.parse(raw as string);
           }
         } catch (e) {
           const m = typeof raw === 'string' ? raw.match(/\{[\s\S]*\}/) : null;
           try {
             args = m ? JSON.parse(m[0]) : {};
           } catch {
             console.warn('[LLMClient] Failed to parse tool args for ' + tc.function.name + ': ' + (e instanceof Error ? e.message : String(e)));
             args = {};
           }
         }
        toolCalls.push({ id: tc.id ?? `call_${toolCalls.length}`, name: tc.function.name, arguments: args });
      }

      console.log('[LLMClient] response', selection.provider, selection.modelId, 'contentLen=' + content.length, 'tools=' + toolCalls.length, 'reasoning=' + (reasoning ? 'y' : 'n'));

      if (!content && toolCalls.length === 0) {
        console.log('[LLMClient] model returned reasoning only (no content/tool calls)');
      }

      logLLMCall({
        ...logContext,
        provider: selection.provider,
        model: selection.modelId,
        usedFallback: false,
        endpoint: url,
      });
      return { content, provider: selection.provider, model: selection.modelId, usedFallback: false, reasoning, toolCalls };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`LLM call failed (${selection.provider}), using fallback:`, err);
      logLLMCall({
        ...logContext,
        provider: 'fallback',
        model: selection.modelId,
        usedFallback: true,
        error: errorMsg.slice(0, 200),
      });
      return {
        content: this.fallbackResponse(messages),
        provider: 'fallback',
        model: selection.modelId,
        usedFallback: true,
        reasoning: undefined,
        error: errorMsg.slice(0, 400),
      };
    }
  }

  private fallbackResponse(messages: LLMMessage[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lower = lastUser.toLowerCase();

    // Return clearly-INVALID marker objects (valid JSON, empty payload) so downstream
    // validators (e.g. ArtifactValidator) reject them as failed instead of treating
    // fake-populated data as a real report. The orchestrator then retries.
    if (lower.includes('research') || lower.includes('best practice')) {
      return JSON.stringify({
        _fallbackError: true,
        note: 'offline stub — provider unavailable',
        summary: '',
        terms: [],
        bestPractices: [],
        patterns: [],
        sources: [],
      });
    }
    if (lower.includes('plan') || lower.includes('architecture')) {
      return JSON.stringify({
        _fallbackError: true,
        note: 'offline stub — provider unavailable',
        stack: [],
        architecture: '',
        subtasks: [],
      });
    }
    if (lower.includes('security') || lower.includes('audit')) {
      return JSON.stringify({
        _fallbackError: true,
        note: 'offline stub — provider unavailable',
        passed: false,
        findings: [],
      });
    }
    if (lower.includes('verify') || lower.includes('audit code')) {
      return JSON.stringify({
        _fallbackError: true,
        note: 'offline stub — provider unavailable',
        verdict: 'ERROR',
        notes: '',
      });
    }

    return `// Omni fallback generation for: ${lastUser.slice(0, 80)}\nexport const app = { ready: true };\n`;
  }
}
