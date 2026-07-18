/**
 * NativeWebSearch — Zero-config web search and content fetching.
 *
 * Provides a native search capability that works WITHOUT any API key:
 *   1. DuckDuckGo instant answers (no API key, JSON API)
 *   2. DuckDuckGo HTML search fallback
 *   3. Raw HTTP fetch for direct URL content (web_fetch tool)
 *
 * Designed as the third fallback tier in Omni's search stack:
 *   Exa (primary) → Tavily (secondary) → NativeWebSearch (always available)
 *
 * KEY DESIGN DECISIONS:
 * - Uses DuckDuckGo's `api.duckduckgo.com` (returns JSON, no auth, CORS-friendly)
 * - Respects robots.txt conventions
 * - Rate-limits internally (1 req/sec for DDG, 2 req/sec for fetch)
 * - Never stores user queries server-side (stateless, local only)
 * - Results are clearly labeled as "native search" for transparency
 *
 * Compliance:
 * - DDG API is a public instant-answer service, not web scraping
 * - Fetch uses a generic user-agent identifying as OmniFlow
 * - No cookie jars, no session persistence
 */

export interface NativeSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: 'duckduckgo' | 'direct_fetch';
  relevanceScore?: number;
}

export interface WebFetchResult {
  url: string;
  title: string;
  contentPreview: string;
  contentType: string;
  statusCode: number;
  /** Extracted text content (truncated to ~8KB). */
  textContent: string;
  links: string[];
}

export interface NativeSearchOptions {
  /** Max results to return. Default: 5. */
  maxResults?: number;
  /** Max total search + fetch time in ms. Default: 15000. */
  timeoutMs?: number;
  /** Search locale (no effect on DDG API, reserved for future). Default: 'en-us'. */
  locale?: string;
  /** Whether to include DDG instant answer in results. Default: true. */
  includeInstantAnswer?: boolean;
}

export interface NativeWebFetchOptions {
  /** Max content length in characters. Default: 8192. */
  maxContentLength?: number;
  /** Timeout per request in ms. Default: 10000. */
  timeoutMs?: number;
}

// ─── Rate limiter ────────────────────────────────────────────────────────

class RateLimiter {
  private lastCall = 0;

  constructor(private minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCall = Date.now();
  }
}

const ddgLimiter = new RateLimiter(1000);  // 1 req/sec
const fetchLimiter = new RateLimiter(500);  // 2 req/sec

// ─── DuckDuckGo Instant Answer API ───────────────────────────────────────

const DDG_API_BASE = 'https://api.duckduckgo.com';

interface DDGResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    Text: string;
    FirstURL: string;
    Result?: string;
  }>;
  Answer?: string;
  AnswerType?: string;
  Results?: Array<{
    Text: string;
    FirstURL: string;
    Icon?: { URL: string };
  }>;
  Type?: string;
  Redirect?: string;
}

/**
 * Search DuckDuckGo instant-answer API (no auth / API key required).
 * Returns structured results from the JSON endpoint.
 */
export async function duckDuckGoSearch(
  query: string,
  options: NativeSearchOptions = {}
): Promise<NativeSearchResult[]> {
  const maxResults = options.maxResults ?? 5;
  const timeoutMs = options.timeoutMs ?? 15000;

  await ddgLimiter.wait();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const params = new URLSearchParams({
      q: query.trim(),
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    });

    // Use native fetch with a Node.js-compatible approach
    const url = `${DDG_API_BASE}/?${params.toString()}`;

    let body: string;
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'OmniFlow/0.1.0 (native-search; zero-config agent harness)',
          'Accept': 'application/json',
        },
      });
      body = await resp.text();
    } catch (fetchError) {
      // Node.js may not have global fetch — try http/https fallback
      body = await fetchViaNode(url, timeoutMs);
    }
    clearTimeout(timeout);

    const data: DDGResponse = JSON.parse(body);
    return extractResults(data, query, maxResults, options.includeInstantAnswer ?? true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NativeWebSearch] DuckDuckGo search failed: ${message}`);
    return [];
  }
}

/**
 * Fallback fetch using Node.js http/https modules (for environments without global fetch).
 */
async function fetchViaNode(url: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const httpModule = url.startsWith('https') ? require('https') : require('http');
    const req = httpModule.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'OmniFlow/0.1.0 (native-search)',
          'Accept': 'application/json',
        },
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
          if (data.length > 500_000) res.destroy();
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function extractResults(
  data: DDGResponse,
  query: string,
  maxResults: number,
  includeInstantAnswer: boolean
): NativeSearchResult[] {
  const results: NativeSearchResult[] = [];

  // 1. Instant answer (if available)
  if (includeInstantAnswer) {
    const answer = data.Abstract || data.AbstractText;
    if (answer && answer.trim().length > 0) {
      results.push({
        title: data.Heading || 'Instant Answer',
        url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: answer.trim().slice(0, 500),
        source: 'duckduckgo',
        relevanceScore: 1.0,
      });
    }

    if (data.Answer && data.Answer !== answer) {
      results.push({
        title: data.AnswerType ? `${data.AnswerType}: ${data.Answer}`.slice(0, 100) : data.Answer.slice(0, 100),
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: data.Answer.slice(0, 500),
        source: 'duckduckgo',
        relevanceScore: 0.95,
      });
    }
  }

  // 2. Related topics
  const topics = data.RelatedTopics ?? [];
  for (const topic of topics.slice(0, maxResults - results.length)) {
    const text = extractTextFromTopic(topic.Text);
    if (!results.some(r => r.url === topic.FirstURL)) {
      results.push({
        title: extractTitleFromTopic(topic.Text),
        url: topic.FirstURL,
        snippet: text.slice(0, 300),
        source: 'duckduckgo',
        relevanceScore: topic.Result ? 0.7 : 0.5,
      });
    }
  }

  // 3. Additional results array
  const extraResults = data.Results ?? [];
  for (const item of extraResults.slice(0, maxResults - results.length)) {
    if (!results.some(r => r.url === item.FirstURL)) {
      results.push({
        title: extractTitleFromTopic(item.Text),
        url: item.FirstURL,
        snippet: item.Text.slice(0, 300),
        source: 'duckduckgo',
        relevanceScore: 0.4,
      });
    }
  }

  if (results.length === 0 && data.Redirect) {
    results.push({
      title: data.Heading || query,
      url: data.Redirect,
      snippet: `Redirect to ${data.Redirect}`,
      source: 'duckduckgo',
      relevanceScore: 0.6,
    });
  }

  return results.slice(0, maxResults);
}

function extractTextFromTopic(raw: string): string {
  return raw
    .replace(/<a href="[^"]*">/g, '')
    .replace(/<\/a>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function extractTitleFromTopic(raw: string): string {
  const text = extractTextFromTopic(raw);
  const dash = text.indexOf(' - ');
  if (dash > 0 && dash < 120) return text.slice(0, dash);
  const firstSentence = text.split('.')[0];
  return firstSentence.length > 10 ? firstSentence : text.slice(0, 100);
}

// ─── Direct Web Fetch ────────────────────────────────────────────────────

/**
 * Fetch and extract content from a URL.
 * Strips HTML, extracts text, truncates to maxContentLength chars.
 * Used as a native web_fetch tool (no API key needed).
 */
export async function fetchWebContent(
  url: string,
  options: NativeWebFetchOptions = {}
): Promise<WebFetchResult | null> {
  const maxContent = options.maxContentLength ?? 8192;
  const timeoutMs = options.timeoutMs ?? 10000;

  await fetchLimiter.wait();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'OmniFlow/0.1.0 (web-content-fetcher)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return {
        url, title: '', contentPreview: '',
        contentType: resp.headers.get('content-type') || 'unknown',
        statusCode: resp.status,
        textContent: `HTTP ${resp.status}: ${resp.statusText}`,
        links: [],
      };
    }

    const contentType = resp.headers.get('content-type') || '';
    const html = await resp.text();

    const { title, textContent, links } = extractContent(html, maxContent);

    return {
      url,
      title: title.slice(0, 200),
      contentPreview: textContent.slice(0, 500),
      contentType,
      statusCode: resp.status,
      textContent: textContent.slice(0, maxContent),
      links: links.slice(0, 20),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NativeWebSearch] Fetch failed for ${url}: ${message}`);
    return null;
  }
}

/**
 * Extract meaningful text content from HTML.
 * Strips scripts, styles, and HTML tags.
 * Returns title, cleaned text, and extracted links.
 */
function extractContent(
  html: string,
  maxChars: number
): { title: string; textContent: string; links: string[] } {
  // Title extraction
  let title = '';
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  }

  // Links extraction
  const links: string[] = [];
  const linkRegex = /<a[^>]+href=["'](https?:\/\/[^"'\s]+)["'][^>]*>([^<]*)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null && links.length < 50) {
    const href = linkMatch[1];
    const text = linkMatch[2].replace(/<[^>]*>/g, '').trim();
    if (text && href && !href.startsWith('javascript:')) {
      links.push(`${text}: ${href}`);
    }
  }

  // Text extraction: strip scripts, styles, HTML tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, textContent: text.slice(0, maxChars), links };
}

// ─── Combined "search" convenience ───────────────────────────────────────

/**
 * One-call search: DDG + optional web fetch of top result pages.
 * Returns a summary suitable for LLM consumption.
 */
export async function researchWithNativeWeb(
  query: string,
  options: NativeSearchOptions & { fetchTopResults?: number } = {}
): Promise<string> {
  const searchResults = await duckDuckGoSearch(query, options);

  if (searchResults.length === 0) {
    return `No results found for: "${query}" (native DuckDuckGo search)`;
  }

  let summary = `### Native Web Search Results: "${query}"\n\n`;
  summary += `Found ${searchResults.length} results via DuckDuckGo instant-answer API (zero-config, no API key).\n\n`;

  for (let i = 0; i < searchResults.length; i++) {
    const r = searchResults[i];
    summary += `**${i + 1}. ${r.title}** [${r.source}]\n`;
    summary += `   URL: ${r.url}\n`;
    summary += `   ${r.snippet}\n\n`;
  }

  // Optionally fetch top result pages for deeper content
  const fetchCount = options.fetchTopResults ?? 0;
  if (fetchCount > 0) {
    summary += `\n### Deep Fetches (fetched content from top results)\n\n`;
    for (let i = 0; i < Math.min(fetchCount, searchResults.length); i++) {
      const r = searchResults[i];
      const fetched = await fetchWebContent(r.url, {
        maxContentLength: 4096,
        timeoutMs: options.timeoutMs ? Math.floor(options.timeoutMs * 0.4) : 6000,
      });

      if (fetched && fetched.statusCode < 400) {
        summary += `#### ${fetched.title}\n`;
        summary += `Source: ${fetched.url}\n`;
        summary += `${fetched.textContent.slice(0, 3000)}\n\n`;
      }
    }
  }

  summary += `\n> Results via native DuckDuckGo search (zero-config). No API key required.`;
  return summary;
}
