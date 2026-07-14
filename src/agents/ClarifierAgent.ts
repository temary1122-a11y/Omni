import { LlmAgent } from './LlmAgent';
import type {
  HandoffContract,
  ArtifactManifest,
  UserGoalPacket,
  WorkspaceSnapshot,
  Complexity,
  IntentType,
  ClarifyingQuestion,
} from '../../shared/types';
import type { LLMResponse } from '../routing/LLMClient';
import { sleep, backoffDelayMs } from '../util/async';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ModelRouter } from '../routing/ModelRouter';
import type { EventBus } from '../core/EventBus';

export class ClarifierAgent extends LlmAgent {
  agentId = 'clarifier';
  private lastLlmResponse: LLMResponse | null = null;

  constructor(router: ModelRouter, apiKeys: Record<string, string>, eventBus?: EventBus) {
    super('clarifier', router, apiKeys, eventBus);
  }

   private detectLanguage(text: string): string {
     if (/[а-яА-ЯёЁ]/.test(text)) return 'Russian';
     if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese';
     if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
     return 'English';
   }

  getLastLlmResponse(): LLMResponse | null {
    return this.lastLlmResponse;
  }

  /** Generate project-specific clarifying questions via LLM (Kilo Gateway / router) */
  async generateQuestions(goal: string, workspace?: WorkspaceSnapshot): Promise<ClarifyingQuestion[]> {
    const wsHint = workspace
      ? `Context hint: tech hints: ${workspace.techStack.join(', ') || 'unknown'}. Files: ${workspace.fileTree.slice(0, 8).join(', ') || 'none'}.`
      : '';

    this.currentPhase = 'intake';
    this.emitCommentary('intake', 'Analyzing goal and identifying missing implementation details...');

    const language = this.detectLanguage(goal);
    const prompt = `The user's goal is written in ${language}. IMPORTANT: Ask ALL questions in ${language}.\n\n` +
      `You are a friendly project intake assistant. Return ONLY valid JSON arrays. No markdown, no explanations.\n\n` +
      `Generate exactly 2-3 clarifying questions that are SPECIFIC to the user's goal.
Important: Ask about missing details in the user's own request (not generic "vibe/style" questions).
Keep the questions in plain, non-technical language.

User goal:
${goal}

${wsHint}

CRITICAL OUTPUT REQUIREMENTS:
- Return ONLY a JSON array (no markdown code blocks, no text before/after)
- Start your response directly with [ and end with ]
- Each question object must match the schema:
  - id: unique_snake_case_id (use underscores, no spaces)
  - question: short friendly sentence (ask for a missing decision)
  - options: array of 2-5 short human options (strings)
  - allowCustom: boolean (true)
  - context: 1-sentence explanation of WHY this answer matters for implementation

Example output format:
[
  {
    "id": "trading_pair",
    "question": "Which trading pair do you want to trade?",
    "options": ["BTC/USDT", "ETH/USDT", "Custom"],
    "allowCustom": true,
    "context": "Determines which market data to fetch and order types to use"
  }
]`;

    // Retry logic for LLM calls with exponential backoff
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add delay before retry (exponential backoff)
        if (attempt > 1) {
          const delayMs = backoffDelayMs(attempt - 1, { baseMs: 1000, maxMs: 5000 }); // 1s, 2s, 4s max
          console.log(`[ClarifierAgent] Waiting ${delayMs}ms before attempt ${attempt}`);
          await sleep(delayMs);
        }
        
        const llm = await this.router.call(
          { phase: 'intake', agentRole: 'clarifier', complexity: 'low' },
          prompt,
          `Return valid JSON array only. Keep questions specific to missing details in the user request. Attempt ${attempt}/${maxRetries}.`,
          this.apiKeys
        );
        this.lastLlmResponse = llm;
        if (llm.reasoning) this.emitReasoning('intake', llm.reasoning);
        
        if (!llm.usedFallback) {
          try {
            const parsed = JSON.parse(this.extractJsonFromLLMResponse(llm.content, llm.reasoning));
            const questions = this.normalizeQuestions(Array.isArray(parsed) ? parsed : (parsed as any).questions ?? []);
            if (questions.length > 0) {
              this.emitCommentary('intake', 'Generated ' + questions.length + ' clarifying question(s) that will affect implementation');
              return questions.slice(0, 3);
            }
          } catch (parseError) {
            console.log(`[ClarifierAgent] JSON parse failed on attempt ${attempt}:`, parseError);
            lastError = parseError instanceof Error ? parseError : new Error(String(parseError));
            if (attempt < maxRetries) continue;
          }
        } else {
          console.log(`[ClarifierAgent] LLM used fallback on attempt ${attempt}`);
          break;
        }
      } catch (llmError) {
        console.log(`[ClarifierAgent] LLM call failed on attempt ${attempt}:`, llmError);
        lastError = llmError instanceof Error ? llmError : new Error(String(llmError));
        if (attempt < maxRetries) continue;
      }
    }

    // Only use fallback as last resort after all retries
    console.log('[ClarifierAgent] All retries exhausted, using fallback. Last error:', lastError?.message);
    const fallback = this.generateSmartFallbackQuestions(goal);
    this.emitCommentary('intake', 'Using smart fallback questions — LLM unavailable after retries');
    return fallback;
  }

  /**
   * Generate critical, implementation-affecting clarifying questions AFTER research.
   * Questions must be derived from:
   * - what the user wrote
   * - and what research suggests (bestPractices/terms/patterns)
   *
   * The goal: ask only the missing decisions required to implement the “requested thing”.
   */
  async generateCriticalQuestionsFromResearch(
    goal: string,
    research: { summary?: string; terms?: string[]; bestPractices?: string[]; patterns?: string[]; sources?: string[] } | any,
    workspace?: WorkspaceSnapshot
  ): Promise<ClarifyingQuestion[]> {
    const wsHint = workspace
      ? `Context hint: tech hints: ${workspace.techStack.join(', ') || 'unknown'}. Files: ${workspace.fileTree.slice(0, 8).join(', ') || 'none'}.`
      : '';

const researchText = `Summary: ${research.summary ?? ''}
Terms: ${(research.terms ?? []).slice(0, 10).join(', ')}
Best practices: ${(research.bestPractices ?? []).slice(0, 8).join('; ')}
Patterns: ${(research.patterns ?? []).slice(0, 8).join('; ')}
Sources: ${(research.sources ?? []).slice(0, 8).join(', ')}`;

    const language = this.detectLanguage(goal);
    const prompt = `The user's goal is written in ${language}. IMPORTANT: Ask ALL questions in ${language}.\n\n` +
      `You are an implementation-focused intake assistant. Return ONLY valid JSON arrays. No markdown, no explanations.\n\n` +
      `You will receive:
1) The user's goal/request
2) Research results (best practices/patterns/terms)

Task:
Generate exactly 2-4 CRITICAL clarifying questions that are derived from the user's request.
Ask only about missing details that affect implementation (so the system can build the correct parser/chatbot/etc).

Hard requirements:
- Do NOT ask generic "vibe/style/outcome" questions unless the user's request is missing an essential implementation decision.
- Questions must be in plain, non-technical language.
- Prefer asking about: what to do, what inputs look like, what filters/selection rules are, output format, limits, error handling/retries (when relevant).

User goal (verbatim):
${goal}

Research hints:
${researchText}

${wsHint}

CRITICAL OUTPUT REQUIREMENTS:
- Return ONLY a JSON array (no markdown code blocks, no text before/after)
- Start your response directly with [ and end with ]
- Each question object must match the schema:
  - id: unique_snake_case_id (use underscores, no spaces)
  - question: short friendly sentence asking for a missing decision
  - options: array of 2-5 short human options (strings)
  - allowCustom: boolean (true)
  - context: 1-sentence explanation of why this detail is critical for implementation

Example output format:
[
  {
    "id": "exchange_api",
    "question": "Which exchange API do you want to use?",
    "options": ["HTX", "Binance", "Custom"],
    "allowCustom": true,
    "context": "Determines API integration and authentication requirements"
  }
]`;

    this.currentPhase = 'planning';
    this.emitCommentary('planning', 'Generating critical questions based on user goal + research...');

    // Retry logic for LLM calls with exponential backoff
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add delay before retry (exponential backoff)
        if (attempt > 1) {
          const delayMs = backoffDelayMs(attempt - 1, { baseMs: 1000, maxMs: 5000 }); // 1s, 2s, 4s max
          console.log(`[ClarifierAgent] Waiting ${delayMs}ms before attempt ${attempt}`);
          await sleep(delayMs);
        }
        
        const llm = await this.router.call(
          { phase: 'planning', agentRole: 'clarifier', complexity: 'low' },
          prompt,
          `Return valid JSON array only. Ask critical missing implementation decisions derived from the user request. Attempt ${attempt}/${maxRetries}.`,
          this.apiKeys
        );
        this.lastLlmResponse = llm;
        if (llm.reasoning) this.emitReasoning('planning', llm.reasoning);

        if (!llm.usedFallback) {
          try {
            console.log('[ClarifierAgent] LLM response content:', llm.content);
            const jsonStr = this.extractJsonFromLLMResponse(llm.content, llm.reasoning);
            console.log('[ClarifierAgent] Extracted JSON:', jsonStr);
            const parsed = JSON.parse(jsonStr);
            console.log('[ClarifierAgent] Parsed JSON:', parsed);
            const questions = this.normalizeQuestions(Array.isArray(parsed) ? parsed : (parsed as any).questions ?? []);
            console.log('[ClarifierAgent] Normalized questions:', questions);
            if (questions.length > 0) {
              this.emitCommentary('planning', 'Found ' + questions.length + ' critical implementation gap(s) — these will shape the build');
              return questions.slice(0, 4);
            }
          } catch (parseError) {
            console.log(`[ClarifierAgent] JSON parse failed on attempt ${attempt}:`, parseError);
            lastError = parseError instanceof Error ? parseError : new Error(String(parseError));
            if (attempt < maxRetries) continue;
          }
        } else {
          console.log(`[ClarifierAgent] LLM used fallback on attempt ${attempt}`);
          break;
        }
      } catch (llmError) {
        console.log(`[ClarifierAgent] LLM call failed on attempt ${attempt}:`, llmError);
        lastError = llmError instanceof Error ? llmError : new Error(String(llmError));
        if (attempt < maxRetries) continue;
      }
    }

    // Only use fallback as last resort after all retries
    console.log('[ClarifierAgent] All retries exhausted, using fallback. Last error:', lastError?.message);
    const fallback = this.generateSmartCriticalFallback(goal, researchText);
    this.emitCommentary('planning', 'Using smart fallback questions — LLM unavailable after retries');
    return fallback;
  }

  private normalizeQuestions(raw: unknown[]): ClarifyingQuestion[] {
    return raw
      .map((item, i) => {
        const q = item as Record<string, unknown>;
        const question = String(q.question ?? '').trim();
        if (!question) return null;
        const options = Array.isArray(q.options)
          ? q.options.map(String).filter(Boolean).slice(0, 5)
          : [];
        const result: ClarifyingQuestion = {
          id: String(q.id ?? `q_${i + 1}`),
          question,
          options: options.length > 0 ? options : ['Yes', 'No', 'Not sure'],
          allowCustom: q.allowCustom !== false,
        };
        if (q.context) result.context = String(q.context);
        return result;
      })
      .filter((q): q is ClarifyingQuestion => q !== null);
  }

  private generateSmartFallbackQuestions(goal: string): ClarifyingQuestion[] {
    const g = goal.toLowerCase();
    const language = this.detectLanguage(goal);
    const isRussian = language === 'Russian';
    const questions: ClarifyingQuestion[] = [];

    if (this.isBotGoal(g)) {
      questions.push(
        {
          id: 'bot_type',
          question: isRussian ? 'Какой тип бота вы хотите создать?' : 'What type of bot do you want to build?',
          options: isRussian ? ['Командный бот', 'Бот с inline-запросами', 'Mini app / WebApp', 'Бот уведомлений'] : ['Command-based bot', 'Inline query bot', 'Mini app / WebApp', 'Notification bot'],
          allowCustom: true,
          context: isRussian ? 'Определяет архитектуру бота и модель взаимодействия' : 'Determines the bot architecture and interaction model',
        },
        {
          id: 'bot_hosting',
          question: isRussian ? 'Где должен работать бот / где хоститься?' : 'Where should the bot run / be hosted?',
          options: isRussian ? ['Локально для тестов', 'VPS / облачный сервер', 'Serverless функция'] : ['Local for testing', 'VPS / cloud server', 'Serverless function'],
          allowCustom: true,
          context: isRussian ? 'Влияет на стратегию деплоя и модель персистентности' : 'Affects deployment strategy and persistence model',
        },
        {
          id: 'bot_main_function',
          question: isRussian ? 'Что главное должен делать бот?' : 'What is the main thing the bot should do?',
          options: isRussian ? ['Отвечать на вопросы (AI ассистент)', 'Обрабатывать команды', 'Отправлять уведомления', 'Интегрироваться с внешними сервисами'] : ['Answer questions (AI assistant)', 'Process commands', 'Send notifications/reminders', 'Integrate with external services'],
          allowCustom: true,
          context: isRussian ? 'Определяет основную функциональность и требуемые интеграции' : 'Defines core functionality and required integrations',
        }
      );
    } else if (this.isWebGoal(g)) {
      questions.push(
        {
          id: 'site_type',
          question: isRussian ? 'Какой тип сайта вы хотите?' : 'What type of site do you want?',
          options: isRussian ? ['Landing page', 'Портфолио', 'Сайт документации', 'Блог'] : ['Landing page', 'Portfolio', 'Documentation site', 'Blog'],
          allowCustom: true,
          context: isRussian ? 'Определяет структуру страниц и организацию контента' : 'Determines the page structure and content organization',
        },
        {
          id: 'site_backend',
          question: isRussian ? 'Нужен ли бэкенд?' : 'Do you need a backend?',
          options: isRussian ? ['Нет, только статика', 'Да, с API', 'Да, с базой данных'] : ['No, static only', 'Yes, with API', 'Yes, with database'],
          allowCustom: true,
          context: isRussian ? 'Влияет на требования хостинга и возможности данных' : 'Affects hosting requirements and data capabilities',
        },
        {
          id: 'site_goal',
          question: isRussian ? 'Какова основная цель?' : "What's the primary goal?",
          options: isRussian ? ['Показать продукт', 'Собирать лиды', 'Предоставлять информацию', 'Продавать онлайн'] : ['Showcase product', 'Collect leads', 'Provide information', 'Sell online'],
          allowCustom: true,
          context: isRussian ? 'Влияет на размещение CTA и функции' : 'Influences call-to-action placement and features',
        }
      );
    } else if (this.isParseGoal(g)) {
      questions.push(
        {
          id: 'parse_data',
          question: isRussian ? 'Какие данные нужно извлекать?' : 'What data do you need to extract?',
          options: isRussian ? ['Текстовый контент', 'Таблицы / структурированные данные', 'Медиа файлы', 'Всё вышеперечисленное'] : ['Text content', 'Tables / structured data', 'Media files', 'All of the above'],
          allowCustom: true,
          context: isRussian ? 'Определяет стратегию парсинга и структуру вывода' : 'Determines parsing strategy and output structure',
        },
        {
          id: 'parse_schedule',
          question: isRussian ? 'Как часто запускать?' : 'How often should it run?',
          options: isRussian ? ['Один раз', 'Ежедневно / по расписанию', 'По триггеру / webhook'] : ['One-time only', 'Daily / scheduled', 'On trigger / webhook'],
          allowCustom: true,
          context: isRussian ? 'Влияет на архитектуру и требования к ресурсам' : 'Affects architecture and resource requirements',
        },
        {
          id: 'parse_output',
          question: isRussian ? 'Куда отправлять результаты?' : 'Where should results go?',
          options: isRussian ? ['JSON файл', 'База данных', 'CSV экспорт', 'API endpoint'] : ['JSON file', 'Database', 'CSV export', 'API endpoint'],
          allowCustom: true,
          context: isRussian ? 'Определяет формат вывода и подход к интеграции' : 'Determines output format and integration approach',
        }
      );
    } else if (this.isApiGoal(g)) {
      questions.push(
        {
          id: 'api_type',
          question: isRussian ? 'Какой тип API нужен?' : 'What type of API do you need?',
          options: isRussian ? ['REST API', 'GraphQL API', 'WebSocket / real-time', 'gRPC'] : ['REST API', 'GraphQL API', 'WebSocket / real-time', 'gRPC'],
          allowCustom: true,
          context: isRussian ? 'Определяет протокол и паттерны получения данных' : 'Defines the protocol and data fetching patterns',
        },
        {
          id: 'api_auth',
          question: isRussian ? 'Какой метод аутентификации?' : 'What authentication method?',
          options: isRussian ? ['Нет / открытый', 'API ключ / токен', 'OAuth2 / JWT', 'Basic auth'] : ['None / open', 'API key / token', 'OAuth2 / JWT', 'Basic auth'],
          allowCustom: true,
          context: isRussian ? 'Влияет на реализацию безопасности и контроль доступа' : 'Affects security implementation and access control',
        },
        {
          id: 'api_database',
          question: isRussian ? 'Нужна ли база данных?' : 'Do you need a database?',
          options: isRussian ? ['SQL (PostgreSQL)', 'NoSQL (MongoDB)', 'Файл-based / SQLite', 'Только внешняя БД'] : ['SQL (PostgreSQL)', 'NoSQL (MongoDB)', 'File-based / SQLite', 'External DB only'],
          allowCustom: true,
          context: isRussian ? 'Определяет персистентность данных и выбор ORM' : 'Determines data persistence and ORM choice',
        }
      );
    } else {
      questions.push(
        {
          id: 'expected_output',
          question: isRussian ? 'Какой ожидаемый результат?' : "What's the expected output?",
          options: isRussian ? ['Работающий код / проект', 'План реализации', 'Архитектурная диаграмма'] : ['Working code / project', 'Implementation plan', 'Architecture diagram'],
          allowCustom: true,
          context: isRussian ? 'Определяет объем и формат доставляемого' : 'Defines the deliverable scope and format',
        },
        {
          id: 'priority',
          question: isRussian ? 'Какой приоритет?' : "What's the priority?",
          options: isRussian ? ['Скорость доставки', 'Качество кода', 'Документация', 'Всё сбалансировано'] : ['Speed of delivery', 'Code quality', 'Documentation', 'All balanced'],
          allowCustom: true,
          context: isRussian ? 'Помогает определить компромиссы архитектуры' : 'Helps decide architecture trade-offs',
        },
        {
          id: 'constraints',
          question: isRussian ? 'Есть ли ограничения, которые нужно знать?' : 'Any constraints I should know about?',
          options: isRussian ? ['Совместимость с легаси', 'Определенный стек технологий', 'Бюджет / ресурсы', 'Нет'] : ['Legacy system compatibility', 'Specific tech stack required', 'Budget/resource limits', 'None'],
          allowCustom: true,
          context: isRussian ? 'Предотвращает несовместимые технологические выборы' : 'Prevents incompatible technology choices',
        }
      );
    }

    return questions.slice(0, 3);
  }

  private isBotGoal(text: string): boolean {
    return /bot|telegram|discord|slack|chatbot|chat bot/i.test(text);
  }

  private isWebGoal(text: string): boolean {
    return /website|site|landing|page|web/i.test(text);
  }

  private isParseGoal(text: string): boolean {
    return /parse|scraper|scrape|extract|parsing/i.test(text);
  }

  private isApiGoal(text: string): boolean {
    return /\bapi\b|\bbackend\b|\bservice\b/i.test(text);
  }

  private generateSmartCriticalFallback(goal: string, _researchText: string): ClarifyingQuestion[] {
    const g = goal.toLowerCase();
    const language = this.detectLanguage(goal);
    const isRussian = language === 'Russian';
    const questions: ClarifyingQuestion[] = [];

    if (this.isBotGoal(g)) {
      questions.push(
        {
          id: 'bot_platform',
          question: isRussian ? 'На какие платформы деплоить?' : 'Which platform(s) will you deploy to?',
          options: isRussian ? ['Только Telegram', 'Несколько платформ', 'Еще не решил'] : ['Telegram only', 'Multiple platforms', 'Not decided yet'],
          allowCustom: true,
          context: isRussian ? 'Влияет на выбор библиотек и слой совместимости' : 'Affects library choices and compatibility layer',
        },
        {
          id: 'bot_update_method',
          question: isRussian ? 'Как бот должен получать сообщения?' : 'How should the bot receive messages?',
          options: isRussian ? ['Long polling', 'Webhook / callback', 'Оба метода', 'Не уверен'] : ['Long polling', 'Webhook / callback', 'Both methods', 'Not sure'],
          allowCustom: true,
          context: isRussian ? 'Определяет архитектуру рантайма бота' : 'Determines the bot runtime architecture',
        },
        {
          id: 'bot_admin_features',
          question: isRussian ? 'Нужны ли admin-only функции?' : 'Do you need admin-only features?',
          options: isRussian ? ['Admin команды / панель', 'Ограничения пользователей', 'Без ограничений', 'Кастомный контроль доступа'] : ['Admin commands / panel', 'User restrictions', 'No restrictions', 'Custom access control'],
          allowCustom: true,
          context: isRussian ? 'Влияет на аутентификацию и видимость функций' : 'Affects authentication and feature visibility',
        },
        {
          id: 'bot_language',
          question: isRussian ? 'Какой язык программирования / библиотеки?' : 'What programming language/libraries?',
          options: isRussian ? ['Node.js (Telegraf)', 'Python (aiogram)', 'PHP', 'Другое / не уверен'] : ['Node.js (Telegraf)', 'Python (aiogram)', 'PHP', 'Other / not sure'],
          allowCustom: true,
          context: isRussian ? 'Влияет на выбор библиотек и структуру кода' : 'Affects library selection and code structure',
        }
      );
    } else if (this.isWebGoal(g)) {
      questions.push(
        {
          id: 'web_framework',
          question: isRussian ? 'Какой фреймворк использовать?' : 'What framework should be used?',
          options: isRussian ? ['React / Next.js', 'Vue / Nuxt', 'Svelte / SvelteKit', 'Vanilla / static', 'Не уверен'] : ['React / Next.js', 'Vue / Nuxt', 'Svelte / SvelteKit', 'Vanilla / static', 'Not sure'],
          allowCustom: true,
          context: isRussian ? 'Определяет инструменты сборки и модель компонентов' : 'Determines the build tooling and component model',
        },
        {
          id: 'web_rendering',
          question: isRussian ? 'Статический или динамический рендеринг?' : 'Static or dynamic rendering?',
          options: isRussian ? ['Статический HTML (SPA)', 'Server-side rendering', 'Static site generator', 'Не уверен'] : ['Static HTML (SPA)', 'Server-side rendering', 'Static site generator', 'Not sure'],
          allowCustom: true,
          context: isRussian ? 'Влияет на требования хостинга и SEO стратегию' : 'Affects hosting requirements and SEO strategy',
        },
        {
          id: 'web_hosting',
          question: isRussian ? 'Где хостить?' : 'Where will you host it?',
          options: isRussian ? ['VPS / выделенный сервер', 'Static hosting (Netlify/Vercel)', 'Cloud functions', 'Не решил'] : ['VPS / dedicated server', 'Static hosting (Netlify/Vercel)', 'Cloud functions', 'Not decided'],
          allowCustom: true,
          context: isRussian ? 'Определяет пайплайн деплоя и конфиг сборки' : 'Determines deployment pipeline and build config',
        },
        {
          id: 'web_styles',
          question: isRussian ? 'Подход к стилям?' : 'Styling approach?',
          options: isRussian ? ['CSS / Tailwind', 'Component library (MUI, etc)', 'CSS modules', 'Custom styling'] : ['CSS / Tailwind', 'Component library (MUI, etc)', 'CSS modules', 'Custom styling'],
          allowCustom: true,
          context: isRussian ? 'Влияет на скорость разработки и консистентность дизайна' : 'Affects development speed and design consistency',
        }
      );
    } else if (this.isParseGoal(g)) {
      questions.push(
        {
          id: 'parse_source',
          question: isRussian ? 'Какой источник данных?' : 'What is the data source?',
          options: isRussian ? ['URL сайта', 'API endpoint', 'Локальные файлы', 'Запрос к БД'] : ['Website URL', 'API endpoint', 'Local files', 'Database query'],
          allowCustom: true,
          context: isRussian ? 'Определяет тип парсера и выбор библиотек' : 'Determines the parser type and library choices',
        },
        {
          id: 'parse_format',
          question: isRussian ? 'Формат ввода / структура?' : 'Input format / structure?',
          options: isRussian ? ['HTML / веб страницы', 'JSON / API ответ', 'PDF документы', 'Смешанные форматы'] : ['HTML / web pages', 'JSON / API response', 'PDF documents', 'Mixed formats'],
          allowCustom: true,
          context: isRussian ? 'Влияет на стратегию парсинга и зависимости' : 'Affects parsing strategy and dependencies',
        },
        {
          id: 'parse_schedule',
          question: isRussian ? 'Как часто запускать извлечение?' : 'How often to run the extraction?',
          options: isRussian ? ['Один раз (вручную)', 'По расписанию (cron)', 'On-demand / webhook', 'Непрерывный мониторинг'] : ['Once (manual run)', 'Scheduled (cron)', 'On-demand / webhook', 'Continuous monitoring'],
          allowCustom: true,
          context: isRussian ? 'Влияет на персистентность и планирование' : 'Affects persistence and scheduling implementation',
        },
        {
          id: 'parse_storage',
          question: isRussian ? 'Как хранить результаты?' : 'How to store the results?',
          options: isRussian ? ['JSON файл', 'SQL база данных', 'NoSQL база данных', 'Отправить в API', 'Не решил'] : ['JSON file', 'SQL database', 'NoSQL database', 'Send to API', 'Not decided'],
          allowCustom: true,
          context: isRussian ? 'Определяет пайплайн вывода и слой хранения' : 'Determines output pipeline and storage layer',
        }
      );
    } else if (this.isApiGoal(g)) {
      questions.push(
        {
          id: 'api_persistence',
          question: isRussian ? 'Как персистить данные?' : 'How should data be persisted?',
          options: isRussian ? ['PostgreSQL', 'MongoDB', 'SQLite', 'Без персистентности', 'Внешний сервис'] : ['PostgreSQL', 'MongoDB', 'SQLite', 'No persistence needed', 'External service'],
          allowCustom: true,
          context: isRussian ? 'Влияет на схему БД и выбор ORM' : 'Affects database schema and ORM selection',
        },
        {
          id: 'api_errors',
          question: isRussian ? 'Стратегия обработки ошибок?' : 'Error handling strategy?',
          options: isRussian ? ['Retry при ошибке', 'Fail fast / strict', 'Graceful degradation', 'Log and continue'] : ['Retry on failure', 'Fail fast / strict', 'Graceful degradation', 'Log and continue'],
          allowCustom: true,
          context: isRussian ? 'Определяет устойчивость и подход к логированию' : 'Determines resilience and logging approach',
        },
        {
          id: 'api_scaling',
          question: isRussian ? 'Ожидаемый масштаб / нагрузка?' : 'Expected scale / load?',
          options: isRussian ? ['Низкий трафик (<100 req/day)', 'Средний (1K req/day)', 'Высокий (10K+ req/day)', 'Не уверен'] : ['Low traffic (<100 req/day)', 'Medium (1K req/day)', 'High (10K+ req/day)', 'Not sure'],
          allowCustom: true,
          context: isRussian ? 'Влияет на кэш, БД и решения деплоя' : 'Affects caching, database, and deployment decisions',
        },
        {
          id: 'api_deploy',
          question: isRussian ? 'Цель деплоя?' : 'Deployment target?',
          options: isRussian ? ['Docker контейнер', 'Serverless функция', 'Embedded / monolith', 'Kubernetes', 'Не уверен'] : ['Docker container', 'Serverless function', 'Embedded / monolith', 'Kubernetes', 'Not sure'],
          allowCustom: true,
          context: isRussian ? 'Определяет контейнеризацию и стратегию масштабирования' : 'Determines containerization and scaling strategy',
        }
      );
    } else {
      questions.push(
        {
          id: 'output_type',
          question: isRussian ? 'В какой форме должен быть результат?' : 'What form should the result take?',
          options: isRussian ? ['Работающий код', 'Документация / гайд', 'Конфигурационные файлы', 'Артефакты дизайна'] : ['Working code', 'Documentation / guide', 'Configuration files', 'Design artifacts'],
          allowCustom: true,
          context: isRussian ? 'Помогает определить структуру файлов и доставляемое' : 'Helps determine file structure and deliverables',
        },
        {
          id: 'error_handling',
          question: isRussian ? 'Предпочтение обработки ошибок?' : 'Error handling preference?',
          options: isRussian ? ['Строгая валидация', 'Graceful failures', 'Retry логика', 'Базовая обработка ошибок'] : ['Strict validation', 'Graceful failures', 'Retry logic', 'Basic error handling'],
          allowCustom: true,
          context: isRussian ? 'Влияет на качество кода и устойчивость' : 'Affects code quality and robustness',
        },
        {
          id: 'scaling_needs',
          question: isRussian ? 'Нужно ли масштабирование?' : 'Will this need to scale?',
          options: isRussian ? ['Да, планировать рост', 'Нет, разовое использование', 'Возможно позже', 'Не применимо'] : ['Yes, plan for growth', 'No, single use', 'Maybe later', 'Not applicable'],
          allowCustom: true,
          context: isRussian ? 'Влияет на архитектуру и выбор технологий' : 'Influences architecture and technology choices',
        },
        {
          id: 'deployment',
          question: isRussian ? 'Подход к деплоюю?' : 'Deployment approach?',
          options: isRussian ? ['Один скрипт / запуск', 'Упакованное приложение', 'Контейнер / образ', 'Не нужно'] : ['Single script / run', 'Packaged application', 'Container / image', 'Not needed'],
          allowCustom: true,
          context: isRussian ? 'Влияет на упаковку и доставку' : 'Affects packaging and delivery',
        }
      );
    }

    return questions.slice(0, 4);
  }

  async execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest> {
    if (!this.validateContract(contract)) throw new Error('Invalid handoff contract');

    this.currentPhase = 'intake';
    this.emitReasoning('intake', 'Goal analysis...');

    const { goal, workspaceSnapshot } = contract.contextPacket;
    const taskId = contract.contextPacket.taskId || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const intent = this.classifyIntent(goal);
    const complexity = this.estimateComplexity(goal, workspaceSnapshot);

    const goalPacket: UserGoalPacket = {
      taskId,
      goal,
      intent,
      complexity,
      workspaceSnapshot,
      refinedGoal: goal,
    };

    const content = JSON.stringify(goalPacket, null, 2);
    const relPath = `.omniflow/tasks/${taskId}/goal-packet.json`;
    this.writeFile(workspaceRoot, relPath, content);

    return this.createManifest(contract.subtaskId, [{ filePath: relPath, content, hash: this.hash(content) }], 'Goal packet created');
  }

  private classifyIntent(goal: string): IntentType {
    const g = goal.toLowerCase();
    if (g.includes('research') || g.includes('find')) return 'research';
    if (g.includes('debug') || g.includes('fix')) return 'debug';
    if (g.includes('migrate')) return 'migrate';
    if (g.includes('refactor')) return 'refactor';
    return 'build';
  }

  private estimateComplexity(goal: string, ws: WorkspaceSnapshot): Complexity {
    const complex = /database|auth|deploy|microservice|kubernetes/i.test(goal);
    if (goal.length > 200 || complex) return 'high';
    if (goal.length > 80) return 'medium';
    return 'low';
  }

  private writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
}
