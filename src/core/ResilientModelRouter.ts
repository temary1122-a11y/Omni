import { EventBus } from './EventBus';
import { ModelRouter, RoutingRequest, ModelSelection, Provider } from '../routing/ModelRouter';
import { LLMClient, LLMResponse } from '../routing/LLMClient';
import { RouterHealthMonitor, HealthStatus } from './RouterHealthMonitor';
import type { IpcMessage } from '../../shared/types';
import { hasProviderKey } from '../routing/providerUtils';
import { sleep } from '../util/async';

export interface FallbackStrategy {
  maxRetries: number;
  retryDelayMs: number;
  providers: Provider[];
  fallbackModels: Partial<Record<Provider, string>>;
}

export class ResilientModelRouter extends ModelRouter {
  private eventBus: EventBus;
  private primaryRouter: ModelRouter;
  private fallbackRouters: Map<Provider, ModelRouter>;
  private llmClient: LLMClient;
  private health: RouterHealthMonitor;
  private strategy: FallbackStrategy;
  private requestCounts: Map<string, number> = new Map();

  constructor(
    eventBus: EventBus,
    primaryRouter: ModelRouter,
    fallbackRouters: Map<Provider, ModelRouter>,
    strategy?: Partial<FallbackStrategy>,
    healthMonitor?: RouterHealthMonitor
  ) {
    super();
    this.eventBus = eventBus;
    this.primaryRouter = primaryRouter;
    this.fallbackRouters = fallbackRouters;
    this.llmClient = new LLMClient();
    this.health = healthMonitor ?? new RouterHealthMonitor(eventBus);
    
    // Inject the unified health monitor into the child routers
    this.primaryRouter.setHealthMonitor(this.health);
    this.fallbackRouters.forEach((router) => router.setHealthMonitor(this.health));

    this.strategy = {
      maxRetries: strategy?.maxRetries ?? 3,
      retryDelayMs: strategy?.retryDelayMs ?? 1000,
      providers: strategy?.providers ?? ['openrouter', 'kilo-gateway', 'codik', 'ollama'],
      fallbackModels: strategy?.fallbackModels ?? {
        openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
        'kilo-gateway': 'stepfun/step-3.7-flash:free',
        codik: 'codik-free',
        ollama: 'llama3.2',
      },
    };
  }

  async call(
    request: RoutingRequest,
    prompt: string,
    systemPrompt: string,
    apiKeys: Record<string, string>,
    forceProvider?: string,
    tools?: any[]
  ): Promise<LLMResponse> {
    let lastError: string = '';

    const chain = this.primaryRouter.getCandidateChain(request.agentRole);
    const hasChain = chain.length > 0;
    // When explicit per-provider fallback routers are registered (tests + advanced
    // setups), use the legacy provider loop. Production passes an empty map and
    // relies on the health-aware candidate chain instead.
    const useProviderLoop = this.fallbackRouters.size > 0;

    const providers = this.strategy.providers.sort((a, b) => {
      const aHasKey = hasProviderKey(a, apiKeys);
      const bHasKey = hasProviderKey(b, apiKeys);
      if (aHasKey && !bHasKey) return -1;
      if (!aHasKey && bHasKey) return 1;
      return 0;
    });

    for (let attempt = 0; attempt < this.strategy.maxRetries; attempt++) {
      if (hasChain && !useProviderLoop) {
        for (const selection of chain) {
          if (!this.health.canAttempt(selection.provider, selection.modelId)) {
            this.eventBus.emit({
              type: 'REASONING_TRACE',
              payload: {
                agentId: 'orchestrator',
                phase: request.phase as any,
                thought: `Skipping ${selection.provider}/${selection.modelId}: unhealthy or rate-limited`,
                timestamp: Date.now(),
              },
            });
            continue;
          }

          const router = this.fallbackRouters.get(selection.provider) ?? this.primaryRouter;

          console.log('[ResilientModelRouter] chain attempt', selection.provider, selection.modelId);

          try {
            const startTime = Date.now();
            const response = await this.executeWithTimeout(
              router,
              selection,
              request,
              prompt,
              systemPrompt,
              apiKeys,
              undefined,
              tools
            );
            const latencyMs = Date.now() - startTime;

            if (response.usedFallback) {
              const reason = response.error || 'provider returned fallback';
              this.recordProviderFailure(selection.provider, selection.modelId, reason, attempt);
              this.trackRequest(selection.provider, selection.modelId, false);
              lastError = `${selection.provider}/${selection.modelId}: ${reason}`;

              if (/402|credits required|paid model|insufficient/i.test(reason)) {
                try { router.markCreditsExhausted?.(); } catch { /* ignore */ }
              }

              this.eventBus.emit({
                type: 'ERROR_OCCURRED',
                payload: {
                  error: `Provider ${selection.provider}/${selection.modelId} degraded (fallback): ${reason}`,
                  phase: request.phase as any,
                  recoverable: true,
                },
              });
              continue;
            }

            this.health.recordSuccess(selection.provider, selection.modelId, latencyMs);
            this.trackRequest(selection.provider, selection.modelId, true);
            return response;

          } catch (error: any) {
            this.recordProviderFailure(selection.provider, selection.modelId, error.message, attempt);
            this.trackRequest(selection.provider, selection.modelId, false);
            lastError = error.message;

            if (this.isRateLimitError(error)) {
              const retryAfter = this.extractRetryAfter(error);
              this.health.recordRateLimit(selection.provider, selection.modelId, retryAfter);
            }

            this.eventBus.emit({
              type: 'ERROR_OCCURRED',
              payload: {
                error: `Provider ${selection.provider}/${selection.modelId} failed: ${error.message}`,
                phase: request.phase as any,
                recoverable: true,
              },
            });
          }
        }
      } else {
        // Legacy provider-loop: one model selection per configured provider.
        for (const provider of providers) {
          const router = this.fallbackRouters.get(provider) || this.primaryRouter;
          const selection = router.route(request, apiKeys, prompt, provider);
          const status = this.health.getStatus(selection.provider, selection.modelId);

          console.log('[ResilientModelRouter] provider attempt', provider, selection.provider);

          if (!this.health.canAttempt(selection.provider, selection.modelId)) {
            this.eventBus.emit({
              type: 'REASONING_TRACE',
              payload: {
                agentId: 'orchestrator',
                phase: request.phase as any,
                thought: `Skipping ${selection.provider}/${selection.modelId}: unhealthy or rate-limited`,
                timestamp: Date.now(),
              },
            });
            continue;
          }

          try {
            const startTime = Date.now();
            const response = await this.executeWithTimeout(
              router,
              selection,
              request,
              prompt,
              systemPrompt,
              apiKeys,
              provider,
              tools
            );
            const latencyMs = Date.now() - startTime;

            if (response.usedFallback) {
              const reason = response.error || 'provider returned fallback';
              this.recordProviderFailure(selection.provider, selection.modelId, reason, attempt);
              this.trackRequest(selection.provider, selection.modelId, false);
              lastError = `${selection.provider}/${selection.modelId}: ${reason}`;

              if (/402|credits required|paid model|insufficient/i.test(reason)) {
                try { (router as any).markCreditsExhausted?.(); } catch { /* ignore */ }
              }

              this.eventBus.emit({
                type: 'ERROR_OCCURRED',
                payload: {
                  error: `Provider ${selection.provider}/${selection.modelId} degraded (fallback): ${reason}`,
                  phase: request.phase as any,
                  recoverable: true,
                },
              });
              continue;
            }

            this.health.recordSuccess(selection.provider, selection.modelId, latencyMs);
            this.trackRequest(selection.provider, selection.modelId, true);
            return response;

          } catch (error: any) {
            this.recordProviderFailure(selection.provider, selection.modelId, error.message, attempt);
            this.trackRequest(selection.provider, selection.modelId, false);
            lastError = error.message;

            if (this.isRateLimitError(error)) {
              const retryAfter = this.extractRetryAfter(error);
              this.health.recordRateLimit(selection.provider, selection.modelId, retryAfter);
            }

            this.eventBus.emit({
              type: 'ERROR_OCCURRED',
              payload: {
                error: `Provider ${selection.provider}/${selection.modelId} failed: ${error.message}`,
                phase: request.phase as any,
                recoverable: true,
              },
            });
          }
        }
      }

      if (attempt < this.strategy.maxRetries - 1) {
        await sleep(this.strategy.retryDelayMs * (attempt + 1));
      }
    }

    return this.llmClient.complete(
      { provider: 'fallback', modelId: 'offline', maxTokens: 3500, costTier: 'free' },
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      apiKeys,
      { agentRole: request.agentRole, phase: request.phase }
    );
  }

  private recordProviderFailure(
    provider: Provider,
    modelId: string,
    reason: string,
    attempt: number
  ): void {
    const deferPermanent = attempt < this.strategy.maxRetries - 1;
    if (this.isPermanentError(reason) && !deferPermanent) {
      this.health.markPermanentlyUnhealthy(provider, modelId, reason);
    } else {
      this.health.recordFailure(provider, modelId, reason);
    }
  }

  private async executeWithTimeout(
    router: ModelRouter,
    selection: ModelSelection,
    request: RoutingRequest,
    prompt: string,
    systemPrompt: string,
    apiKeys: Record<string, string>,
    forceProvider?: string,
    tools?: any[],
    forcedSelection?: ModelSelection
  ): Promise<LLMResponse> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 60000);
    });

    const requestPromise = router.call(request, prompt, systemPrompt, apiKeys, forceProvider, tools, forcedSelection ?? selection);

    return Promise.race([requestPromise, timeoutPromise]);
  }

  private isRateLimitError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';
    return message.includes('rate limit') || message.includes('429') || message.includes('quota');
  }

  private isPermanentError(error: string): boolean {
    const m = (error || '').toLowerCase();
    return (
      m.includes('404') ||
      m.includes('not found') ||
      m.includes('unavailable for free') ||
      m.includes('does not exist') ||
      m.includes('no longer available') ||
      m.includes('decommissioned') ||
      m.includes('not a valid model') ||
      m.includes('invalid model') ||
      m.includes('model not found') ||
      m.includes('unknown model')
    );
  }

  private extractRetryAfter(error: any): number {
    // Try to extract retry-after header or default to 60 seconds
    const match = error.message?.match(/retry[-\s]?after[:\s]+(\d+)/i);
    if (match) {
      return parseInt(match[1]) * 1000;
    }
    return 60000;
  }

  private trackRequest(provider: Provider, modelId: string, success: boolean): void {
    const key = `${provider}:${modelId}`;
    const current = this.requestCounts.get(key) || 0;
    this.requestCounts.set(key, current + 1);
  }


  getHealthStatus(): HealthStatus[] {
    return this.health.getAllStatuses();
  }

  getHealthyProviders(): Provider[] {
    return this.health.getHealthyProviders();
  }

  resetHealth(provider?: Provider, modelId?: string): void {
    this.health.reset(provider, modelId);
  }

  addFallbackRouter(provider: Provider, router: ModelRouter): void {
    this.fallbackRouters.set(provider, router);
  }

  setStrategy(strategy: Partial<FallbackStrategy>): void {
    this.strategy = { ...this.strategy, ...strategy };
  }
}
