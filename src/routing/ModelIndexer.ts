import { EventBus } from '../core/EventBus';
import { RouterHealthMonitor } from '../core/RouterHealthMonitor';
import { ModelSelection } from './ModelRouter';
import type { ModelCapability } from './ModelCapabilityRegistry';
import { FreeModelCapabilityRegistry } from './ModelCapabilityRegistry';
import { PROVIDER_API_KEY_ENV, PROVIDER_MODEL_LIST_ENDPOINTS } from './providerUtils';
import { classifyPriceLabel } from './pricingTiers';

export interface ModelMetadata {
  modelId: string;
  provider: string;
  price: string;
  contextWindow: number;
  benchmarks: {
    mmlu: number;
    gsm8k: number;
    humanEval: number;
    mtBench: number;
  };
  roleSuitability: string[];
}

export interface ModelIndexerOptions {
  eventBus?: EventBus;
  healthMonitor?: RouterHealthMonitor;
  apiKeys?: Record<string, string>;
}

export type ModelIndexerFetcher = (
  url: string,
  headers: Record<string, string>
) => Promise<{ ok: boolean; json: () => Promise<any> }>;

const PROVIDER_ENDPOINTS = (Object.keys(PROVIDER_MODEL_LIST_ENDPOINTS) as Array<keyof typeof PROVIDER_MODEL_LIST_ENDPOINTS>).map(
  (provider) => ({
    provider,
    url: PROVIDER_MODEL_LIST_ENDPOINTS[provider],
    envKey: PROVIDER_API_KEY_ENV[provider],
  })
);

type ProviderEndpoint = (typeof PROVIDER_ENDPOINTS)[number];

export class ModelIndexer {
  private models: ModelMetadata[] = [];
  private eventBus?: EventBus;
  private healthMonitor?: RouterHealthMonitor;
  private apiKeys: Record<string, string> = {};

  fetcher: ModelIndexerFetcher = (url, headers) =>
    fetch(url, { headers }).then(async (res) => ({
      ok: res.ok,
      json: () => res.json(),
    }));

  constructor(options: ModelIndexerOptions = {}) {
    this.eventBus = options.eventBus;
    this.healthMonitor = options.healthMonitor;
    this.apiKeys = (options as any).apiKeys ?? {};
  }

  // Загрузить индекс из JSON-файла (пока заглушка)
  async loadIndex(filePath: string): Promise<void> {
    // TODO: реализовать чтение файла
    // Пока используем статические данные из model-index.json
    this.models = this.getStaticFallbackModels();
    // Emit event using generic type to avoid TypeScript error
    this.eventBus?.emit({ type: 'INDEX_LOADED', payload: { count: this.models.length } });
  }

  // Статический офлайн-фоллбэк (используется loadIndex и как база для refreshIndex)
  private getStaticFallbackModels(): ModelMetadata[] {
    const registry = new FreeModelCapabilityRegistry();
    return registry.getModels().map((m) => ({
      modelId: m.modelId,
      provider: m.provider,
      price: m.price,
      contextWindow: m.contextWindow,
      benchmarks: m.benchmarks,
      roleSuitability: m.roleSuitability,
    }));
  }

  private mapItem(item: any, provider: ProviderEndpoint['provider']): ModelMetadata {
    const promptPrice = parseFloat(item?.pricing?.prompt);
    const completionPrice = parseFloat(item?.pricing?.completion);
    // Classify into Free / cheap / mid / premium so paid "powerful" models can be
    // indexed and matched against the user's budget tier (see pricingTiers.ts).
    const price = classifyPriceLabel(promptPrice, completionPrice);
    const role = (item?.architecture?.modality ?? 'text').includes('image') ? 'all' : (item?.name ?? '').toLowerCase().includes('coder') ? 'coder' : 'all';
    return {
      modelId: item.id,
      provider,
      price,
      contextWindow: item?.context_length ?? 8192,
      benchmarks: { mmlu: 0, gsm8k: 0, humanEval: 0, mtBench: 0 },
      roleSuitability: [role],
    };
  }

  private async fetchProviderModels(endpoint: ProviderEndpoint): Promise<ModelMetadata[]> {
    const apiKey = this.apiKeys[endpoint.provider] ?? process.env[endpoint.envKey] ?? '';
    if (!apiKey) return [];
    const res = await this.fetcher(endpoint.url, {
      Authorization: `Bearer ${apiKey}`,
    });
    if (!res.ok) return [];
    const body = await res.json();
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    return data.map((item) => this.mapItem(item, endpoint.provider));
  }

  // Обновить индекс на основе текущих API-ключей (реальный запрос к провайдерам)
  async refreshIndex(): Promise<void> {
    const base = this.getStaticFallbackModels();
    const merged = new Map<string, ModelMetadata>();
    for (const m of base) merged.set(m.modelId, m);

    for (const endpoint of PROVIDER_ENDPOINTS) {
      try {
        const fetched = await this.fetchProviderModels(endpoint);
        for (const m of fetched) {
          // Index both free and paid models so budget=normal/high can route to
          // powerful paid models through the same providers. Free-only routing is
          // still enforced downstream by budget/credits-exhausted logic.
          merged.set(m.modelId, m); // fetched entry wins over static
        }
      } catch {
        // skip this provider, keep static fallback — never throw
      }
    }

    this.models = Array.from(merged.values());
    // Emit event using generic type to avoid TypeScript error
    this.eventBus?.emit({
      type: 'INDEX_UPDATED',
      payload: { providers: PROVIDER_ENDPOINTS.map((e) => e.provider) },
    });
  }

  // Выбрать лучшую модель для роли и опциональных требований
  selectModel(
    role: string,
    minContextWindow?: number,
    minBenchmark?: { metric: keyof ModelMetadata['benchmarks']; value: number },
    preferredProviders?: string[]
  ): ModelSelection | null {
    const candidates = this.models.filter((m) => {
      const roleMatch = m.roleSuitability.some(
        (r) => r.toLowerCase() === 'all' || r.toLowerCase() === role.toLowerCase()
      );
      if (!roleMatch) return false;
      // Фильтр по контекстному окну
      if (minContextWindow && m.contextWindow < minContextWindow) return false;
      // Фильтр по бенчмарку
      if (minBenchmark && (m.benchmarks[minBenchmark.metric] ?? 0) < minBenchmark.value)
        return false;
      // Фильтр по провайдеру
      if (preferredProviders && !preferredProviders.includes(m.provider)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // Сортировка: сначала модели с наилучшим соотношением бенчмарка к контекстному окну
    candidates.sort((a, b) => {
      const scoreA = (a.benchmarks.mmlu + a.benchmarks.gsm8k) / a.contextWindow;
      const scoreB = (b.benchmarks.mmlu + b.benchmarks.gsm8k) / b.contextWindow;
      return scoreB - scoreA; // по убыванию
    });

    const best = candidates[0];
    return {
      provider: best.provider as any, // приведение типа
      modelId: best.modelId,
      costTier: 'free',
      maxTokens: role === 'coder' ? 4000 : 3500,
    };
  }

  // Получить все модели (пересечённый список после refresh или статический фоллбэк)
  getModels(): ModelCapability[] {
    return [...this.models];
  }

  // Получить все модели
  getAllModels(): ModelMetadata[] {
    return this.models;
  }

  // Получить модели для конкретного провайдера
  getModelsForProvider(provider: string): ModelMetadata[] {
    return this.models.filter((m) => m.provider === provider);
  }
}
