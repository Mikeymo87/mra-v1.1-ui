// Web search + rendered-page fetch for the MRA, with no Firecrawl dependency.
//
// webSearch(query)  -> { provider, results: [{ title, url, description }] }
//   Provider chain (first one configured wins; a provider that fails or returns nothing
//   falls through to the next):
//     1. Google Programmable Search   needs GOOGLE_CSE_KEY + GOOGLE_CSE_ID   (100/day free)
//     2. Jina Search                  needs JINA_API_KEY                     (free key)
//     3. Claude web search            needs ANTHROPIC_API_KEY (always set)   (~$0.01/search)
//
// fetchPageFallback(url) -> { provider, content }  Claude web fetch for pages Jina Reader
//   cannot render. Used by read_page only after Jina returns too little.
//
// The pure helpers (normalizeResults, parseClaudeSearchMessage, providerOrder) are exported
// for tests and have no network access.

const Anthropic = require('@anthropic-ai/sdk');

const SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || 'claude-sonnet-4-6';
const DEFAULT_LIMIT = 5;

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) anthropicClient = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- pure helpers ---------------------------------------------------------

// Keep http(s) results only, dedupe by URL, fill a missing description with the title.
function normalizeResults(raw, limit = DEFAULT_LIMIT) {
  const out = [];
  const seen = new Set();
  for (const r of raw || []) {
    const url = String(r?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(r.title || '').trim() || url;
    const description = String(r.description || '').trim() || title;
    out.push({ title, url, description });
    if (out.length >= limit) break;
  }
  return out;
}

// Which providers apply for a given env (exported so tests can pin the order).
function providerOrder(env = process.env) {
  const order = [];
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_ID) order.push('google');
  if (env.JINA_API_KEY) order.push('jina');
  if (env.ANTHROPIC_API_KEY) order.push('claude');
  return order;
}

const PROVIDER_LABEL = {
  google: 'Google Programmable Search',
  jina: 'Jina Search',
  claude: 'Claude Web Search',
};

// Find a JSON array of results in model text: a {"results":[...]} object (structured
// output), a bare array, or an array embedded in prose. Returns [] when none parses.
function extractJsonArray(text) {
  const t = String(text || '').trim();
  const candidates = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const firstBracket = t.indexOf('[');
  const lastBracket = t.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(t.slice(firstBracket, lastBracket + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.results)) return v.results;
    } catch (e) { /* try next candidate */ }
  }
  return [];
}

// Pull results out of a Claude message that used the web_search server tool.
// Titles/URLs come from the web_search_tool_result block; descriptions from the JSON
// array the model was told to write. Returns { results, error }.
function parseClaudeSearchMessage(message) {
  const results = [];
  let jsonDescriptions = new Map();
  let error = null;

  for (const block of message?.content || []) {
    if (block.type === 'web_search_tool_result') {
      const content = block.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'web_search_result') {
            results.push({ title: item.title || '', url: item.url || '', description: '', page_age: item.page_age || null });
          }
        }
      } else if (content && typeof content === 'object' && content.error_code) {
        error = `web_search error: ${content.error_code}`;
      }
    } else if (block.type === 'text' && block.text) {
      const arr = extractJsonArray(block.text);
      for (const r of arr) {
        if (r && r.url) jsonDescriptions.set(String(r.url).replace(/\/+$/, '').toLowerCase(), r);
      }
    }
  }

  // The model's picks (with descriptions) lead, in the model's order; any remaining
  // tool-block results follow so nothing found is lost.
  const byKey = new Map(results.map(r => [r.url.replace(/\/+$/, '').toLowerCase(), r]));
  const ordered = [];
  for (const [key, j] of jsonDescriptions) {
    const base = byKey.get(key);
    ordered.push({
      title: (base && base.title) || j.title || '',
      url: (base && base.url) || j.url,
      description: j.description ? String(j.description) : '',
      page_age: base ? base.page_age : null,
    });
    byKey.delete(key);
  }
  for (const r of byKey.values()) ordered.push(r);
  return { results: ordered, error };
}

// ---- providers ------------------------------------------------------------

async function googleSearch(query, limit) {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_CSE_KEY,
    cx: process.env.GOOGLE_CSE_ID,
    q: query,
    num: String(Math.min(limit, 10)),
  });
  const res = await fetchWithTimeout(`https://www.googleapis.com/customsearch/v1?${params}`, {}, 20000);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `Google CSE HTTP ${res.status}`);
  return (data.items || []).map(i => ({ title: i.title, url: i.link, description: i.snippet }));
}

async function jinaSearch(query, limit) {
  const res = await fetchWithTimeout(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      'X-Respond-With': 'no-content',
    },
  }, 30000);
  const data = await res.json();
  if (!res.ok || data.code >= 400) throw new Error(data.message || `Jina search HTTP ${res.status}`);
  return (data.data || []).slice(0, limit).map(i => ({ title: i.title, url: i.url, description: i.description }));
}

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'description'],
        properties: { title: { type: 'string' }, url: { type: 'string' }, description: { type: 'string' } },
      },
    },
  },
};

async function claudeSearch(query, limit) {
  const client = getClient();
  // Basic web_search variant on purpose: the dynamic-filtering variant runs code execution
  // and writes prose (27 s, no JSON). Structured output forces the JSON shape.
  const message = await client.messages.create({
    model: SEARCH_MODEL,
    max_tokens: 2048,
    system: `You are a web search endpoint. Run exactly one web search for the user's query. Then output only the results as JSON: up to ${limit} objects with title, url (only URLs returned by the search, never invented), and a one-sentence description of why the page matters for the query. Prefer recent, authoritative sources.`,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    messages: [{ role: 'user', content: query }],
    output_config: { format: { type: 'json_schema', schema: SEARCH_SCHEMA } },
  }, { timeout: 60000 });
  const { results, error } = parseClaudeSearchMessage(message);
  if (error && results.length === 0) throw new Error(error);
  return results;
}

const PROVIDERS = { google: googleSearch, jina: jinaSearch, claude: claudeSearch };

/**
 * Search the web. Tries each configured provider in order until one returns results.
 * @returns {{ provider: string, providerKey: string, results: Array<{title,url,description}>, attempts: Array<{provider,error?,count?}> }}
 */
async function webSearch(query, { limit = DEFAULT_LIMIT } = {}) {
  const attempts = [];
  for (const key of providerOrder()) {
    try {
      const raw = await PROVIDERS[key](query, limit);
      const results = normalizeResults(raw, limit);
      attempts.push({ provider: key, count: results.length });
      if (results.length > 0) return { provider: PROVIDER_LABEL[key], providerKey: key, results, attempts };
    } catch (e) {
      attempts.push({ provider: key, error: e.message });
    }
  }
  const err = new Error(attempts.length ? `All search providers failed: ${attempts.map(a => `${a.provider}: ${a.error || 'no results'}`).join('; ')}` : 'No search provider configured (set ANTHROPIC_API_KEY, or GOOGLE_CSE_KEY+GOOGLE_CSE_ID, or JINA_API_KEY)');
  err.attempts = attempts;
  throw err;
}

/**
 * Fetch a rendered page through Claude's web fetch tool. Returns markdown-ish text.
 * Used only when Jina Reader could not extract the page.
 */
async function fetchPageFallback(url) {
  const client = getClient();
  const message = await client.messages.create({
    model: SEARCH_MODEL,
    max_tokens: 16000,
    system: 'You are a page extraction endpoint. Fetch the URL the user gives you exactly once, then reply with ONLY the main readable content of that page as plain text or markdown. No commentary, no summary, no code fence. If the page could not be fetched, reply with exactly: FETCH_FAILED',
    tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1, max_content_tokens: 40000 }],
    messages: [{ role: 'user', content: `Fetch and return the content of ${url}` }],
  }, { timeout: 90000 });

  let docText = '';
  let modelText = '';
  for (const block of message.content || []) {
    if (block.type === 'web_fetch_tool_result') {
      const c = block.content;
      if (c && c.type === 'web_fetch_result' && c.content) {
        const doc = c.content;
        const src = doc.source;
        if (src && typeof src.data === 'string') docText = src.data;
        else if (typeof doc.text === 'string') docText = doc.text;
      } else if (c && c.error_code) {
        throw new Error(`web_fetch error: ${c.error_code}`);
      }
    } else if (block.type === 'text') {
      modelText += block.text;
    }
  }
  if (/^\s*FETCH_FAILED\s*$/.test(modelText)) throw new Error('web_fetch could not retrieve the page');
  const content = (docText && docText.length >= modelText.length ? docText : modelText).trim();
  return { provider: 'Claude Web Fetch', content };
}

module.exports = { webSearch, fetchPageFallback, normalizeResults, parseClaudeSearchMessage, extractJsonArray, providerOrder, PROVIDER_LABEL };
