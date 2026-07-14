import { LlmAgent } from './LlmAgent';
import type { HandoffContract, ArtifactManifest, ResearchReport } from '../../shared/types';
import { ModelRouter } from '../routing/ModelRouter';
import type { EventBus } from '../core/EventBus';
import type { ConsultFn } from '../core/AgentConsultant';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRuntime } from '../core/AgentRuntime';
import { ToolRegistry, createDefaultTools } from '../core/ToolRegistry';
import { formatResearchBlock } from '../core/promptUtils';

export class ResearchAgent extends LlmAgent {
  agentId = 'researcher';
  private consultFn?: ConsultFn;
  private searchMode: 'auto' | 'skip' | 'fallback' = 'auto';

  constructor(router: ModelRouter, apiKeys: Record<string, string>, eventBus?: EventBus) {
    super('researcher', router, apiKeys, eventBus);
  }

   setConsultFn(fn: ConsultFn): void {
     this.consultFn = fn;
   }

  setSearchMode(mode: 'auto' | 'skip' | 'fallback'): void {
    this.searchMode = mode;
  }

  /**
   * Lightweight research entry point used OUTSIDE the build pipeline — e.g.
   * when the orchestrator routes a "find the news" / live-web request from
   * chat mode, or when another agent consults the researcher. It builds a
   * minimal handoff contract and runs the SAME real research loop that owns
   * the `web_search` tool (Exa/Tavily), so the agent answers from live web
   * data rather than its training memory.
   */
  async runAdHocResearch(goal: string, workspaceRoot: string): Promise<ResearchReport> {
    const taskId = `chat_research_${Date.now()}`;
    const contract: HandoffContract = {
      subtaskId: `research_${taskId}`,
      agentRole: 'researcher',
      successCriteria: ['Research report'],
      artifactTargets: [{ filePath: `.omniflow/tasks/${taskId}/research-report.json`, contentType: 'doc' as any }],
      contextPacket: {
        taskId,
        goal,
        workspaceSnapshot: { fileTree: [], hasPackageJson: false, hasReadme: false, techStack: [] },
      },
    };
    const manifest = await this.execute(contract, workspaceRoot);
    const raw = manifest.artifacts[0]?.content ?? '';
    try {
      const parsed = JSON.parse(raw);
      return {
        taskId,
        summary: parsed.summary ?? '(no summary)',
        terms: parsed.terms ?? [],
        bestPractices: parsed.bestPractices ?? [],
        patterns: parsed.patterns ?? [],
        sources: parsed.sources ?? [],
      };
    } catch {
      return {
        taskId,
        summary: raw.slice(0, 600) || '(no result)',
        terms: [],
        bestPractices: [],
        patterns: [],
        sources: [],
      };
    }
  }

  /**
   * When another agent consults the researcher, run REAL research (with web
   * search) instead of a bare text reply — the researcher owns web search.
   */
  async respondToPrompt(prompt: string, context: any[]): Promise<any> {
    if (this.requiresLiveWeb(prompt)) {
      try {
        const report = await this.runAdHocResearch(prompt, this.workspaceRootForAdHoc());
        const sources = (report.sources ?? []).filter(Boolean);
        const body =
          report.summary +
          (sources.length ? `\n\nSources:\n${sources.slice(0, 8).join('\n')}` : '');
        return { content: body, confidence: 0.9, needsMoreInfo: false, metadata: { usedWebSearch: true } };
      } catch (error) {
        this.emitCommentary(
          'research',
          'Live research failed; falling back to a plain response: ' +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
    return super.respondToPrompt(prompt, context);
  }

  /** Best-effort workspace root for ad-hoc (consult) calls. */
  private workspaceRootForAdHoc(): string {
    // AgentRuntime/execute need a workspace root; the research agent has no
    // stored root, so derive one from cwd as a safe default.
    return process.cwd();
  }

  private requiresLiveWeb(goal: string): boolean {
    const g = goal.toLowerCase();
    const liveSignals = [
      'news', 'новост', 'сегодня', 'today', 'current', 'latest', 'recent', 'up-to-date', 'up to date',
      'актуальн', 'последн', 'свеж', 'сейчас', 'right now', 'this week', 'this month', 'this year',
      'этот год', 'цен', 'курс', 'price', 'prices', 'rate', 'rates', 'weather', 'погод',
      'stock', 'stocks', 'trending', 'happening', 'происходит', 'find', 'search', 'look up', 'lookup',
      'найди', 'поищ', 'узнай', 'выясни', 'google', 'what is the',
    ];
    return liveSignals.some((s) => g.includes(s));
  }

  /**
   * Real web search for the researcher. Uses Exa or Tavily REST APIs (global fetch)
   * when an API key is available. Gracefully returns empty results otherwise so the
   * agent falls back to its normal LLM-only behavior.
   */
  private async webSearch(goal: string): Promise<{ sources: string[]; context: string }> {
    if (this.searchMode === 'skip') {
      this.emitCommentary('research', 'Web search skipped by user (continue without tool)');
      return { sources: [], context: '' };
    }
    if (this.searchMode === 'fallback') {
      this.emitCommentary('research', 'Using keyless fallback web search');
      return this.keylessSearch(goal);
    }
    const exaKey = this.apiKeys?.['EXA_API_KEY'] ?? process.env['EXA_API_KEY'];
    const tavilyKey = this.apiKeys?.['TAVILY_API_KEY'] ?? process.env['TAVILY_API_KEY'];
    if (!exaKey && !tavilyKey) {
      this.emitCommentary('research', 'No EXA/TAVILY API key found — skipping live web search');
      return { sources: [], context: '' };
    }

    const queries = this.deriveQueries(goal);
    const found: { url: string; text: string }[] = [];

    for (const q of queries) {
      try {
        if (exaKey) {
          const res = await fetch('https://api.exa.ai/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': exaKey },
            body: JSON.stringify({ query: q, numResults: 3 }),
          });
          if (!res.ok) {
            this.emitCommentary('research', `Exa search failed with HTTP ${res.status}`);
            continue;
          }
          const data: any = await res.json();
          for (const r of data?.results ?? []) {
            found.push({ url: r.url, text: (r.title || '') + '\n' + (r.text || r.summary || '') });
          }
        } else if (tavilyKey) {
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 3 }),
          });
          if (!res.ok) {
            this.emitCommentary('research', `Tavily search failed with HTTP ${res.status}`);
            continue;
          }
          const data: any = await res.json();
          for (const r of data?.results ?? []) {
            found.push({ url: r.url, text: (r.title || '') + '\n' + (r.content || '') });
          }
        }
      } catch (e) {
        this.emitCommentary('research', 'web search query failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    const sources = found.map((r) => r.url).filter(Boolean).slice(0, 8);
    const context = found.map((r) => `SOURCE ${r.url}\n${r.text}`).join('\n\n').slice(0, 6000);
    return { sources, context };
  }

  /**
   * Best-effort keyless web search fallback (no API key). Uses DuckDuckGo's public
   * endpoint. Unreliable by nature — callers must degrade gracefully if it returns nothing.
   */
  private async keylessSearch(goal: string): Promise<{ sources: string[]; context: string }> {
    const queries = this.deriveQueries(goal);
    const found: { url: string; text: string }[] = [];
    for (const q of queries) {
      try {
        const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1';
        const res = await fetch(url);
        if (!res.ok) {
          this.emitCommentary('research', `Keyless search failed with HTTP ${res.status}`);
          continue;
        }
        const data: any = await res.json();
        const topics: any[] = data?.RelatedTopics ?? [];
        for (const t of topics.slice(0, 5)) {
          if (t?.Text) found.push({ url: t.FirstURL || '', text: String(t.Text) });
        }
      } catch (e) {
        this.emitCommentary('research', 'keyless search query failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    const sources = found.map((r) => r.url).filter(Boolean).slice(0, 8);
    const context = found.map((r) => `SOURCE ${r.url}\n${r.text}`).join('\n\n').slice(0, 6000);
    return { sources, context };
  }

  private async searchQuery(query: string): Promise<{ url: string; text: string }[]> {
    if (this.searchMode === 'skip') return [];
    const exaKey = this.apiKeys?.['EXA_API_KEY'] ?? process.env['EXA_API_KEY'];
    const tavilyKey = this.apiKeys?.['TAVILY_API_KEY'] ?? process.env['TAVILY_API_KEY'];
    const one = async (url: string, headers: Record<string, string>, body: any): Promise<{ url: string; text: string }[]> => {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        if (!res.ok) {
          this.emitCommentary('research', `Web search failed with HTTP ${res.status}`);
          return [];
        }
        const data: any = await res.json();
        if (url.includes('exa.ai')) {
          return (data?.results ?? []).map((r: any) => ({ url: r.url, text: (r.title || '') + '\n' + (r.text || r.summary || '') }));
        }
        return (data?.results ?? []).map((r: any) => ({ url: r.url, text: (r.title || '') + '\n' + (r.content || '') }));
      } catch (error) {
        this.emitCommentary(
          'research',
          'Web search request failed: ' + (error instanceof Error ? error.message : String(error))
        );
        return [];
      }
    };
    if (this.searchMode !== 'fallback' && exaKey) {
      return one('https://api.exa.ai/search', { 'x-api-key': exaKey }, { query, numResults: 4 });
    }
    if (this.searchMode !== 'fallback' && tavilyKey) {
      return one('https://api.tavily.com/search', {}, { api_key: tavilyKey, query, max_results: 4 });
    }
    // Out-of-the-box: no key required — keyless fallback.
    return this.keylessSearchQuery(query);
  }

  private async keylessSearchQuery(query: string): Promise<{ url: string; text: string }[]> {
    try {
      const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1';
      const res = await fetch(url);
      if (!res.ok) {
        this.emitCommentary('research', `Keyless search failed with HTTP ${res.status}`);
        return [];
      }
      const data: any = await res.json();
      return (data?.RelatedTopics ?? []).slice(0, 5).filter((t: any) => t?.Text).map((t: any) => ({ url: t.FirstURL || '', text: String(t.Text) }));
    } catch (error) {
      this.emitCommentary(
        'research',
        'Keyless search request failed: ' + (error instanceof Error ? error.message : String(error))
      );
      return [];
    }
  }

  private deriveQueries(goal: string): string[] {
    const base = goal.replace(/\s+/g, ' ').trim().slice(0, 200);
    return [base, base + ' best practices', base + ' library comparison'].slice(0, 3);
  }

  private isReportValid(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.summary !== 'string' || parsed.summary.length < 20) return false;
      if (!Array.isArray(parsed.sources) || parsed.sources.length < 1) return false;
      return true;
    } catch {
      return false;
    }
  }

  async execute(contract: HandoffContract, workspaceRoot: string): Promise<ArtifactManifest> {
    if (!this.validateContract(contract)) throw new Error('Invalid handoff contract');

    const { goal, taskId, researchReport: upstreamReport } = contract.contextPacket;

    this.currentPhase = 'research';
    const searchSession = {
      seenQueries: new Set<string>(),
      seenUrls: new Set<string>(),
      staleStreak: 0,
    };
    const normalizeQuery = (q: string) =>
      q.toLowerCase().replace(/\s+/g, ' ').replace(/\b(best practices|library comparison|tools?|2024|2025)\b/g, '').replace(/[^\p{L}\p{N} ]/gu, '').trim();

    this.emitCommentary('research', 'Starting research on user goal + workspace context...');
    this.emitReasoning('research', 'Starting research for goal...');

    // Tools: live web_search (out of the box) + file read/write.
    const sandboxTool = this.getSandboxTool(workspaceRoot);
    const semanticEditor = this.getSemanticEditor(workspaceRoot);
    const { tools: defaultTools, executors: defaultExecutors } = createDefaultTools(sandboxTool, semanticEditor, workspaceRoot);
    const toolRegistry = new ToolRegistry(this.eventBus!);

    toolRegistry.register('web_search', {
      name: 'web_search',
      description: 'Search the LIVE web for current, accurate information. Returns sources with URLs + text. Plan 3-5 DISTINCT sub-questions and search each ONCE with a different query. NEVER repeat a query you already ran — if web_search reports a duplicate or "no new results", move on to fetch_page or write the report.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
    }, async (args: any) => {
      const query = String(args.query ?? goal);
      const norm = normalizeQuery(query);
      if (searchSession.seenQueries.has(norm)) {
        searchSession.staleStreak++;
        return { success: true, output: `(duplicate query — already searched. Unique sources so far: ${searchSession.seenUrls.size}. STOP searching and write the report via write_file now.)`, durationMs: 0 };
      }
      searchSession.seenQueries.add(norm);
      const results = await this.searchQuery(query);
      const newUrls = results.map((r) => r.url).filter(Boolean).filter((u) => !searchSession.seenUrls.has(u));
      if (newUrls.length === 0) {
        searchSession.staleStreak++;
        return { success: true, output: `(no new results for "${query}". Unique sources so far: ${searchSession.seenUrls.size}. Try a genuinely different angle or synthesize the report now.)`, durationMs: 0 };
      }
      newUrls.forEach((u) => searchSession.seenUrls.add(u));
      searchSession.staleStreak = 0;
      const out = results.map((r) => `SOURCE ${r.url}\n${r.text}`).join('\n\n');
      return { success: true, output: out || '(no results)', durationMs: 0 };
    });

    toolRegistry.register('fetch_page', {
      name: 'fetch_page',
      description: 'Fetch a single web page URL and return its readable text (title + main content). Use this to read a promising source found via web_search in depth. Input: url (string).',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Fully-qualified URL to fetch' } }, required: ['url'] },
    }, async (args: any) => {
      const fetchedUrl = String(args.url);
      try {
        const res = await fetch(fetchedUrl, { headers: { 'User-Agent': 'OmniResearch/1.0' } });
        if (!res.ok) return { success: false, error: 'HTTP ' + res.status, durationMs: 0 };
        searchSession.seenUrls.add(fetchedUrl);
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
        return { success: true, output: (text || '(empty page)').slice(0, 4000), durationMs: 0 };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e), durationMs: 0 };
      }
    });

    for (const name of ['read_file', 'write_file']) {
      const t = defaultTools.find((x) => x.name === name);
      if (t) toolRegistry.register(name, t, defaultExecutors[name]);
    }

    const researchBlock = formatResearchBlock(upstreamReport);

    const targetPath = `.omniflow/tasks/${taskId}/research-report.json`;
    const rolePrompt =
      'You are a technical research agent. Your job: gather CURRENT, accurate information from the live web, then save a research report.\n' +
      'Available tools:\n' +
      '- web_search(query): search the live web. Returns sources with URLs + text. Plan 3-5 DISTINCT sub-questions and search each ONCE with a different query. NEVER repeat a query you already ran — if web_search reports a duplicate or "no new results", move on.\n' +
      '- fetch_page(url): fetch one promising source URL and read its full text in depth. Use it to go deeper on the best 1-2 sources.\n' +
      '- write_file(path, content): write the final report.\n' +
      'After you have 4-6 solid unique sources (web_search tells you how many unique sources you have), STOP searching and synthesize. Do NOT keep searching the same thing.\n' +
      'Write the report to EXACTLY this path: ' + targetPath + '\n' +
      'The file MUST be VALID JSON with these keys: summary (string), terms (array of strings), bestPractices (array of strings), patterns (array of strings), sources (array of URLs/names as strings).\n' +
      'Rules:\n' +
      '- Put the REAL SOURCE urls you found via web_search/fetch_page into the sources array.\n' +
      '- Keep it focused; do not pad.\n' +
      '- Nothing else matters except writing that JSON file.\n' +
      (researchBlock ? 'Prior partial research context:\n' + researchBlock + '\n' : '');

    const runtime = new AgentRuntime(
      this.eventBus!,
      this.router,
      toolRegistry,
      {
        agentId: 'researcher',
        tools: toolRegistry.list(),
        maxIterations: 12,
        systemPrompt: this.composeSystemPrompt('research', goal, rolePrompt),
        workspaceRoot,
        boundary: contract.boundary,
        onReasoning: (thought) => this.emitReasoning('research', thought),
        onIteration: (iteration, ctx) => {
          const urlCount = searchSession.seenUrls.size;
          if (urlCount >= 6) {
            return { systemNote: `You have gathered ${urlCount} unique sources — that is enough. Stop searching immediately and write the report file now using write_file.` };
          }
          if (searchSession.staleStreak >= 3) {
            return { systemNote: `Your last ${searchSession.staleStreak} searches returned no new information. Stop searching and synthesize the report via write_file now.` };
          }
          return {};
        },
        apiKeys: this.apiKeys,
      }
    );

    let manifest = await runtime.run(goal, { ...contract.contextPacket, taskId: contract.subtaskId });
    let gatheredSources = Array.from(searchSession.seenUrls);
    let report!: ResearchReport;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = manifest.artifacts[0]?.content;
      if (raw && this.isReportValid(raw)) {
        const parsed = JSON.parse(raw);
        report = {
          taskId,
          summary: parsed.summary ?? `Research aligned to user decisions: ${goal.slice(0, 100)}`,
          terms: parsed.terms ?? [],
          bestPractices: parsed.bestPractices ?? ['Keep MVP aligned with user outcome', 'Follow chosen vibe/style', 'Document how to run'],
          patterns: parsed.patterns ?? ['Modular structure'],
          sources: parsed.sources ?? gatheredSources,
        };
        break;
      }

      if (attempt === 3) break;

      gatheredSources = Array.from(searchSession.seenUrls);
      this.emitCommentary('research', `Attempt ${attempt}: invalid or missing report, retrying with ${gatheredSources.length} gathered sources`);
      const retryGoal = goal + '\n\nCRITICAL: Your previous attempt failed to produce a valid report. ' +
        (gatheredSources.length > 0
          ? `You have gathered these real source URLs: ${gatheredSources.join(', ')}. You MUST include all of them in the sources array of your JSON report. `
          : 'You have NO gathered sources — write a report with sources: ["none"] and an honest summary. '
        ) +
        'Call write_file with valid JSON containing summary (string, >= 20 chars), sources (array, >= 1 item), terms, bestPractices, patterns.';
      manifest = await runtime.run(retryGoal, { ...contract.contextPacket, taskId: contract.subtaskId });
    }

    if (!report) {
      const gathered = Array.from(searchSession.seenUrls);
      if (gathered.length > 0) {
        report = {
          taskId,
          summary: `Research aggregated from ${gathered.length} live web sources for: ${goal.slice(0, 120)}`,
          terms: [],
          bestPractices: [],
          patterns: [],
          sources: gathered.slice(0, 16),
        };
      } else {
        report = {
          taskId,
          summary: `No live sources gathered for: ${goal.slice(0, 120)}`,
          terms: [],
          bestPractices: [],
          patterns: [],
          sources: [],
        };
      }
    }

    const content = JSON.stringify(report, null, 2);
    const full = path.join(workspaceRoot, targetPath);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to persist research report "${targetPath}": ${message}`);
    }

    return this.createManifest(contract.subtaskId, [{ filePath: targetPath, content, hash: this.hash(content) }], report.summary);
  }
}
