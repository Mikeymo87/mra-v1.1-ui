# BH Market Research Agent v1.1 — Session Handoff

## Project Locations

| What | Path |
|---|---|
| **App (UI)** | `~/Desktop/Claude/MRA-v1.1-UI/` |
| **n8n Workflow JSON** | `~/Desktop/Claude/MRA-v1.1-UI/bh-mra-v1.1-workflow.json` |
| **GitHub** | https://github.com/Mikeymo87/mra-v1.1-ui |
| **Replit** | Deployed from GitHub — Node.js, `npm start`, port 5000 |
| **n8n Workflow** | https://michaelmora.app.n8n.cloud/workflow/XqCHfLZzMpDEURGu |
| **n8n Webhook** | `POST https://michaelmora.app.n8n.cloud/webhook/market-research` |

---

## Architecture

```
Browser (localhost:5000 / Replit)
  → Smart clarification (client-side, no API cost)
  → Local knowledge base (segments, competitors, strategy — no API cost)
  → Response cache (sessionStorage — no API cost on repeat queries)
  → n8n webhook (POST with session_id for conversation memory)
      → Claude Sonnet 4.6 agent (maxIterations: 5, memory: 20 messages)
          → 9 tools: Yext locations, Yext physicians, Census, Google Places,
            Drive Times, Geocode, Web Research, Outscraper Reviews, ORS Isochrone
      → Plan Mode Check → Send Response (direct, no async/polling)
```

---

## What Changed This Session (April 15, 2026)

### n8n Workflow Changes
- **LLM:** Tested GPT-4.1 mini, reverted to Claude Sonnet 4.6 (better instruction following)
- **Removed async polling pattern** — was: Generate Job ID → Acknowledge → Store → Poll → Return. Now: Webhook → Agent → Respond directly. No more job_id/polling
- **Error handling:** `continueOnFail: true` on Agent + Plan Mode Check nodes so errors reach the response node instead of hanging
- **System prompt trimmed 36%** — removed city polygons (1,200 tokens), brand colors, isochrone rendering, detailed Census variable listings, ZIP county URL lists
- **Maps opt-in only** — agent no longer renders Static Maps URLs unless explicitly asked
- **Tool routing rewritten** — explicit routing table (9 query types → specific tools). Agent must call a tool for every data question, never answer from memory
- **Scope discipline updated** — specific care type queries return only those types; broad "what's nearby" returns everything
- **Location verification rule** — agent must check Yext before building analysis around any BH location
- **Analyst writing standards** — no hedging, name real locations only, competitor tables must include address/stars/reviews/threat level
- **ENGLISH ONLY rule strengthened** — explicit ASCII-only constraint with named script examples (Georgian, Korean, etc.)
- **Medicare Advantage note added** — Census counts MA under Medicare (public), not private. Agent notes MA penetration when reporting payer mix
- **12 BH audience segments** — replaced 7 made-up cohorts with 8 Healthgrades framework segments + 4 new South Florida segments. Framework only — no pre-set numbers, agent builds from live Census data
- **Physician Lookup tool added** — new Yext node with `entityTypes=healthcareProfessional` for doctor/specialty searches (needs Yext schema verification)
- **Conversation memory bumped** — 10 → 20 messages per session
- **All tool URLs restructured** — base URLs hardcoded in templates, `$fromAI` only handles small dynamic parts (filter, keyword, address). Prevents "URL undefined" errors
- **Yext urgent care $or filter** — searches both "Urgent Care" and "Same-Day Care" in one call
- **Duplicate $fromAI key fixed** — Google Reviews Deep Pull had duplicate `cutoff` parameter descriptions

### App (UI) Changes
- **Built from scratch** — vanilla HTML/JS, Express server, no framework
- **Smart clarification** — vague queries get client-side prompts before calling agent (location type picker, distance selector, ZIP input for demographics). Zero API cost
- **Local knowledge base** — 12 BH segments, 18 competitors, service taxonomy, territory, payer mix strategy. Answers definitional questions instantly without API call
- **Agent-first matching** — any query with geography, ZIPs, action verbs, comparisons, or data requests always goes to the agent. Local knowledge only fires on pure "what is X" questions
- **Response cache** — sessionStorage, max 50 entries, normalized query keys. Repeat questions are free
- **Request deduplication** — prevents duplicate in-flight API calls
- **Enter key debounce** — 300ms on Enter, button click is immediate
- **Yext locations pre-loaded** — all BH facilities fetched on page load for future client-side filtering
- **Session-based memory** — unique session_id sent with every request. Follow-up questions have full context from prior messages (20-message window)
- **Copy / PDF / Word buttons** — dark pill style under every response. Copy sends raw markdown, PDF opens print dialog, Word downloads .doc
- **Markdown rendering** — dark header tables with BH mint text, green H3 headers, hover highlights on table rows

---

## 12 BH Consumer Segments (Framework Only)

| Segment | Who They Are |
|---|---|
| Babies and Bills | Young women, Medicaid, high maternity/obstetrics, social media |
| Pinterest and Planning | Younger women, commercial, health-conscious, digital-first |
| Settling Down | Young married men, healthcare influenced by partner, need PCP |
| Weekend Warriors | Single men, Medicaid, ED entry, substance abuse, trauma |
| One Day at a Time | Middle-age, diverse, metabolic syndrome, high clinical need |
| Stable and Seeking Care | Largest, highest commercial + value, Primary Care entry |
| Senior Discounts | Older Medicare, highest chronic burden, vascular/neuro/cardio |
| Empty Nests, Full Pockets | Affluent seniors, active, musculoskeletal, high digital adoption |
| Brickell Briefcase | Urban professionals 25-40, commercial, convenience-driven |
| Mi Familia Primero | Hispanic/Latino multigenerational, bilingual, community trust |
| Snowbird Circuit | Seasonal affluent 60+, continuity of care, concierge demand |
| Grit and Grind | Blue-collar, uninsured/underinsured, ED entry, price-sensitive |

No pre-set numbers. Agent derives all demographics and payer data from live Census + web research.

---

## Cost Optimization Summary

| Optimization | Savings |
|---|---|
| System prompt trim (-2,000 tokens) | ~$0.03/query |
| Local knowledge base (definitional questions) | ~30% of queries free |
| Response cache (repeat queries) | ~30% cache hit rate |
| Request dedup + debounce | Prevents waste |
| Conversation memory (follow-ups reuse prior tool results) | ~$0.07/follow-up |
| **Estimated total** | **~60% cost reduction** |

---

## Known Issues / Next Steps

- **Physician Lookup:** Node added but Yext `healthcareProfessional` entity type needs verification. Test the API to confirm BH has physician data and which fields are populated
- **Drive Time Isochrone:** Uses wrong credential (Outscraper instead of OpenRouteService). Fix in n8n UI after import — swap to ORS credential
- **Segment psychographics:** Each segment needs Census proxy variable definitions (what to look for) so the agent knows how to score them from data. Currently thematic only
- **Yext client-side filtering:** Locations are pre-loaded on app startup but not yet used for client-side answering. Could eliminate more agent calls for simple "where is BH X?" queries
- **Replit deployment:** Server listens on `0.0.0.0:5000`. Replit should work out of the box with `npm start`
- **Anthropic prompt caching:** n8n's lmChatAnthropic node (v1.3) doesn't support it natively. Consider Autocache proxy or wait for n8n update

---

## To Continue

1. Open Claude Code from `~/Desktop/Claude/MRA-v1.1-UI/`
2. Say "continue the build" or reference this handoff
3. n8n JSON is at `bh-mra-v1.1-workflow.json` in this folder — upload to n8n after changes
4. App runs with `npm start` → http://localhost:5000
