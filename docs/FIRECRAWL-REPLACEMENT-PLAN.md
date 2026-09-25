# Replace Firecrawl in the MRA so the subscription can be cancelled

Plan date: 2026-09-25. Owning project: `~/Desktop/Claude/MRA-v1.1-UI/` (repo `Mikeymo87/mra-v1.1-ui`, live at `bh-market-research-agentv-111.replit.app`).
Step 0 of execution copies this file to `MRA-v1.1-UI/docs/FIRECRAWL-REPLACEMENT-PLAN.md` and removes this copy.

## Goal

The MRA's two web tools (`web_research`, `read_page`) keep working with no Firecrawl dependency, verified locally and on the live Replit deploy, so Mike can cancel the Firecrawl Hobby plan (~$16/mo plus credit top-ups) without the MRA, the Insight Miner newsletter, or the Marketing Plan GPT losing web research.

**Done means observed:**
1. `web_research` returns titles, URLs and descriptions for a real query with `FIRECRAWL_API_KEY` removed from the environment.
2. `read_page` still extracts a normal page via Jina Reader, and extracts a JS-rendered page via the new fallback.
3. Both verified on the live Replit URL after deploy, then again after the Firecrawl secret is deleted from Replit.
4. Firecrawl no longer appears in MRA code, tool descriptions, or CLAUDE.md. Tool log row updated to "ready to cancel".

## Context

Mike wants to cancel Firecrawl but keep the MRA "working well, without skipping a beat" and asked me to pick the replacement and verify it. Where Firecrawl is used today:

- `server.js` `case 'web_research'` (line ~1061): POST `api.firecrawl.dev/v1/search`, `limit: 5`, returns `[{title,url,description}]`. Called by the chat agent, by the newsletter workflow (`prompts/workflow-pulse.txt`, "batch 3-4 web_research calls"), and by `marketData.js` line ~911 for the market-news block.
- `server.js` `case 'read_page'` (line ~1088): Jina Reader (`r.jina.ai`, free, keyless) is already primary. Firecrawl `/scrape` is only the fallback when Jina returns under 200 chars (JS-rendered pages).
- Tool descriptions at lines 379 and 390 name Firecrawl; `marketData.js` source labels say "Firecrawl Web Search" and "Jina Reader / Firecrawl Scrape"; CLAUDE.md tool list items 3 and 4.

Other projects: **SDC Listing Audit** never reaches Firecrawl anymore (Yelp returns "collector only" before the Firecrawl branch; Google, Bing, Apple, Waze use their own sources). No change there. **BrandStash v2** IS in scope (Mike, 9/25: "we need to make sure the search works correctly still"): see the BrandStash section below.

## BrandStash v2: HealthMerch live products without Firecrawl

What it does today: `server/firecrawl-search.ts` -> `searchHealthMerchLive()` (called from `server/openai.ts` line ~387, the "External Vendor Recommendations" step of AI event recommendations). It maps event keywords to up to 3 HealthMerch category URLs, scrapes each via Firecrawl `/scrape` (markdown), and `parseProductsFromMarkdown()` pulls `/product/...` links, derives the name from the URL slug, looks for a nearby `$` price, caches 1 hour. If nothing comes back, `openai.ts` falls back to the static catalog. The inventory search itself is plain text and never touched Firecrawl.

**Tested 9/25:** a plain HTTP fetch of a HealthMerch category page returns 0 bytes (browser-rendered only). Jina Reader (`r.jina.ai/<url>`, free, keyless) returns the rendered page as markdown with 39 product links for the water-bottle category. Prices do not appear on category pages in either path, so `price: ""` today stays `price: ""` (no regression; the parser already tolerates it). Images come back as blob URLs, which the parser already ignores.

**Change:**
- Rename `server/firecrawl-search.ts` -> `server/healthmerch-live.ts` (import updated in `openai.ts`). `scrapeCategory()` fetches `https://r.jina.ai/${categoryUrl}` with `Accept: text/plain`, 25 s timeout, same 1-hour cache, same empty-array-on-failure behavior so the static fallback keeps working. The `FIRECRAWL_API_KEY` gate is removed.
- `parseProductsFromMarkdown()` link regex accepts both relative `/product/...` and absolute `https://www.healthmerch.com/product/...` (Jina emits absolute URLs); names still derived from the slug; dedupe by product path.
- Log lines say "HealthMerch live" instead of "Firecrawl".
- Pure parser test (`server/healthmerch-live.test.ts` if the repo has a test runner, else a `scripts/test-healthmerch-live.ts` smoke run with `tsx`) covering absolute and relative links, dedupe, slug-to-name, and no-price.

**Deploy:** BrandStash's Repl publishes workspace files from branch `desiree-july-fixes` (never merged to main). Commit to that branch, push, then in the Repl: Git pane fetch, merge in the Shell, Republish. Live check on brand-stash-v-2.replit.app: request an AI event recommendation that mentions water bottles or tumblers and confirm the vendor block lists live HealthMerch products (server log: "HealthMerch live parsed N products"). Untracked `AGENTS.md` in that repo is prior work; left alone.

**Free-search findings (tested 9/25):** Jina Search (`s.jina.ai`) returns 401 without an API key. DuckDuckGo's HTML endpoints return a bot challenge (202 / empty). No Google, Brave, Tavily or Jina search keys exist on disk. The one search backend that needs nothing from Mike is Anthropic's built-in web search tool (the MRA already runs on the Anthropic SDK with `ANTHROPIC_API_KEY`): pay-per-use, about one cent per search plus a small model call, no subscription.

## Design

**Provider chain** in a new module `webTools.js`, so the MRA works today with zero setup and becomes fully free the moment Mike adds one key:

1. **Google Programmable Search** if `GOOGLE_CSE_KEY` and `GOOGLE_CSE_ID` are set (official JSON API, 100 searches/day free, snippet output matches the tool contract exactly).
2. **Jina Search** if `JINA_API_KEY` is set (free key, 10M-token allowance; same vendor as the reader).
3. **Anthropic web search** always available (`web_search_20260209` server tool on the app's existing model `claude-sonnet-4-6`, `max_uses: 1`). A small Messages call with a system prompt that says: search once, then reply only with a JSON array of up to 5 `{title,url,description}` drawn from the results. Results come from the `web_search_tool_result` block (title, url, page_age); descriptions from the model's JSON, matched by URL; missing descriptions fall back to the title. An error-object `content` on the tool result is treated as a provider failure.

A provider that throws or returns zero results falls through to the next. The envelope's `source` names the provider that answered ("Google Programmable Search", "Jina Search", "Claude Web Search") so the model's citations stay honest. If every provider fails, the tool returns the same `{ error }` envelope shape it returns today.

**read_page fallback:** Jina Reader stays primary. The Firecrawl scrape fallback becomes Anthropic **web fetch** (`web_fetch_20260209`, same model, URL passed in the user turn, `max_uses: 1`): the `web_fetch_tool_result` document text becomes the page content. No per-use fee beyond tokens. If that also yields under 200 chars, return `{ error: 'Could not extract readable content from this page' }`.

**Env:** `FIRECRAWL_API_KEY` removed from local `.env` and from Replit secrets after verification. Optional keys documented in CLAUDE.md: `GOOGLE_CSE_KEY`, `GOOGLE_CSE_ID`, `JINA_API_KEY`.

## Files

- `webTools.js` (NEW): `webSearch(query, { limit })`, `fetchPageFallback(url)`, the three provider functions, and pure helpers `parseSearchResponse(message)` / `normalizeResults(...)` exported for tests.
- `server.js`: `case 'web_research'` calls `webSearch`; `case 'read_page'` step 2 calls `fetchPageFallback`; tool descriptions at ~379 and ~390 drop the Firecrawl wording ("Web search. Returns titles, URLs and short descriptions..." / "...Tries Jina Reader first; falls back to a rendered fetch for JavaScript-heavy pages.").
- `marketData.js`: source labels come from the envelope's `source` instead of hardcoded Firecrawl strings.
- `tests/webTools.test.js` (NEW, `node --test`): parser against a fixture Anthropic response (results block plus JSON text), error-object handling, provider order given env combinations, normalization (missing description falls back to title, https-only, dedupe by URL).
- `scripts/test-web-tools.mjs` (NEW): live smoke, run with `FIRECRAWL_API_KEY` unset: one `webSearch` on a BH-relevant query, one `read_page` on a static page (Jina path), one on a JS-heavy page (fallback path). Prints provider used and result counts.
- `package.json`: `"test": "node --test tests/*.test.js"`, `"smoke:web": "node scripts/test-web-tools.mjs"`.
- `CLAUDE.md`: tools 3 and 4 rewritten; env list updated; deploy note.
- `.env`: drop `FIRECRAWL_API_KEY` (after local verification).
- Tool log `Mikes-Agent-Team/AI-Usage-Log/tool-subscriptions.md`: Firecrawl row -> "READY TO CANCEL" after live verification; recurring total updated when Mike cancels.
- Memory: `project_mra_v3.md` (or the MRA v2 file) note; `reference_firecrawl_jina.md` updated to say Firecrawl is gone; `project_brandstash.md` note that HealthMerch live scrape now silently uses the static catalog.

## Execution order

0. Handoff check: `git status` / `git pull --ff-only` in `MRA-v1.1-UI`. Existing uncommitted items (`data/bh-facility-cache.json`, six `data/reviews-cache/*.json`, `AGENTS.md`, `psa-commercial-coverage.html`) are prior work. Leave them untouched and out of my commit; mention them to Mike.
1. Write `webTools.js`, wire `server.js` and `marketData.js`, write tests. `npm test`.
2. Local smoke with `FIRECRAWL_API_KEY` unset (env -u): the three checks above. Then start the server locally and run one chat request that forces a web search, confirm the SSE stream shows the tool call and a sourced answer.
3. Commit (only my files) and push. Deploy on Replit: Git pane fetch, `git merge origin/main` in the Shell, `npm install`, Republish. Verify live by hitting the chat endpoint with the same forced-search prompt.
4. Delete `FIRECRAWL_API_KEY` from Replit secrets (Mike or me via Chrome), republish, re-run the live check. Remove from local `.env`.
5. BrandStash: code + parser test locally, then commit to `desiree-july-fixes`, push, pull + Republish in its Repl, live vendor-recommendation check, then remove its `FIRECRAWL_API_KEY` secret and re-check.
6. Docs, tool log, memory. Tell Mike Firecrawl is safe to cancel.

## Verification additions for BrandStash

- Parser test green on absolute and relative links.
- Local run of `searchHealthMerchLive("water bottles for a 5K")` returns live products with names derived from slugs.
- Live app: AI event recommendation shows HealthMerch products in the vendor block after deploy, and again after the Firecrawl secret is removed.

## Verification

- `npm test` green (parser, provider order, normalization).
- Local smoke output shows `provider: Claude Web Search` (or Google/Jina if a key was added) with 3-5 results, Jina read on a static page, fallback read on a JS page, all with no Firecrawl variable in the environment.
- Live Replit chat request returns a web-sourced answer after deploy, and again after the Firecrawl secret is removed.
- `grep -ri firecrawl` in `MRA-v1.1-UI` returns only the plan doc and git history.

## Risks and notes

- Cost: Anthropic web search is about $10 per 1,000 searches plus a short Sonnet call. At the MRA's usage (a handful of searches per session, 3-4 per newsletter section) this is cents per month, far below the $16-plus Firecrawl plan. Adding `GOOGLE_CSE_KEY`+`GOOGLE_CSE_ID` later makes it free.
- The model used for the helper call is the app's existing `claude-sonnet-4-6`, kept for consistency with the rest of `server.js`; not upgraded in this change.
- The newsletter workflow batches several `web_research` calls in one turn; each becomes its own small Messages call. Fine for volume, slightly slower than Firecrawl's single HTTP call. Timeout stays 60 s per call.
- Replit deploy mechanics are the same as the dashboard repo (Git pane fetch works, shell fetch does not); documented in the dashboard's AGENTS.md and applied here.
