# BH Market Research Agent v2.1 — Session Handoff

## Project Locations

| What | Path |
|---|---|
| **App** | `~/Desktop/Claude/MRA-v1.1-UI/` |
| **GitHub** | https://github.com/Mikeymo87/mra-v1.1-ui |
| **Replit** | bh-market-research-agentv-111.replit.app |
| **Claude Code context** | `CLAUDE.md` in project root |
| **Marketing Plan GPT handoff** | `MRA-CAPABILITIES.md` in project root |

---

## Architecture (v2.1)

```
Browser (localhost:5000 / Replit)
  → sessionStorage cache (cleared on refresh)
  → POST /api/chat (SSE streaming)
      → Express server (server.js)
          → Anthropic SDK (claude-sonnet-4-20250514)
              → tool_use loop (max 25 iterations)
                  → 9 tools: Yext facilities, Yext physicians, Census,
                    Google Places, Distance Matrix (flattened), Geocode,
                    Web Research, Outscraper Reviews, ORS Isochrone
              → SSE stream response back to browser
```

**No n8n dependency.** The n8n workflow JSON is kept as backup but is not active.

---

## What Changed — v2.1 (April 20, 2026)

### Data Accuracy Fixes
- **Distance Matrix flattened** — server pre-processes Google's nested `rows[].elements[]` into flat `{origin, destination, duration, distance}` objects. Eliminates index misattribution that caused fabricated drive times.
- **truncateResult limit 8000→50000** — was cutting API response JSON mid-array. Agent received broken data and hallucinated missing values.
- **Geocoding city name mandatory** — South Florida has duplicate addresses across cities (e.g., 1400 SW 145th Ave in both Miami and Pembroke Pines, 17 miles apart). Tool description and system prompt now require exact city name and post-geocode verification.
- **Physician filter fixed** — `c_specialty` (broken, returns API error) → `c_listOfSpecialties` (works). `c_credentials` (doesn't exist) → `degrees`.

### Coverage Fixes
- **19 facility categories** — mapped from BH Network of Care PDF. Full keyword reference with entity counts + zero-result blocklist in system prompt.
- **22 physician specialty keywords** — verified against Yext with counts.
- **City adjacency map** — hardcoded for 14 South Florida cities. Pembroke Pines requires 9 Yext calls (origin + 8 adjacent). Marked MANDATORY — model was skipping cities when not enforced.
- **Urgent care bias removed** — 7 instances of UC-first language neutralized across system prompt + tool descriptions.

### New Workflows
- **DEMOGRAPHIC ANALYSIS WORKFLOW** — 6 structured output sections: Trade Area Overview, Population by ZIP, Age Distribution (with commercially addressable population 18-64), Payer Mix by ZIP, Language & Cultural Context, Marketing Implications. Validation rules prevent count/percentage confusion.
- **PHYSICIAN ANALYSIS WORKFLOW** — mandatory city search, specialty + city filters, drive time verification, mile and minute radius support.
- **CONTEXT-AWARE QUERIES** — overlap vs feeder classification for new facility planning. Agent asks for service lines, searches relevant categories, classifies each result.
- **RADIUS INTERPRETATION** — handles both "within 5 miles" and "within 15 minutes." Defaults to 15-min drive time if unspecified.

### Guardrails
- **Payer Targeting Rule** — Dan's directive: marketing dollars target commercially insured (18-64) only. Medicare/Medicaid come organically. Baked into system prompt.
- **Zero-hallucination rule** — every data point must trace to a tool call. Sources section required on every response.
- **Truncation warning** — if tool result is truncated, agent must re-call with fewer items. Never use truncated data.
- **Result verification** — agent must read `destination_addresses` from Distance Matrix to confirm mapping before reporting drive times.
- **Cache-clear on refresh** — sessionStorage cleared on page load so refresh = fresh results.

### Infrastructure
- **MAX_ITERATIONS = 25** — supports 19-category location searches + 9-city physician searches.
- **Anti-hallucination source citations** — every response ends with Sources block listing APIs called and what was returned.

---

## Files

| File | Purpose |
|---|---|
| `server.js` | Express backend, 9 tool executors, SSE streaming, flattened Distance Matrix, truncation limit 50K |
| `system-prompt.txt` | 35K char system prompt, 7 workflows, city adjacency map, payer targeting rule |
| `public/index.html` | Chat UI, SSE streaming, markdown rendering, cache-clear-on-refresh |
| `.env` | 7 API keys — never commit |
| `CLAUDE.md` | Claude Code context file |
| `MRA-CAPABILITIES.md` | Handoff doc for Marketing Plan GPT |
| `HANDOFF.md` | This file |
| `bh-mra-v1.1-workflow.json` | Old n8n workflow (backup, not active) |
| `package.json` | Dependencies: express, dotenv, @anthropic-ai/sdk |

---

## API Keys Required (.env)

| Key | Service | Used By |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet (agent brain) | server.js |
| `YEXT_API_KEY` | BH facilities + physicians | Tools 1, 9 |
| `CENSUS_API_KEY` | US Census ACS 5-Year | Tool 2 |
| `OPENAI_API_KEY` | gpt-4o web search | Tool 3 |
| `GOOGLE_MAPS_API_KEY` | Geocode, Distance Matrix, Places | Tools 4, 5, 6 |
| `OUTSCRAPER_API_KEY` | Google Reviews deep pull | Tool 7 |
| `ORS_API_KEY` | OpenRouteService isochrones | Tool 8 |

---

## Estimated Cost Per Marketing Plan

A full marketing plan build typically requires 6-10 MRA queries across different data types. Here's the cost breakdown:

### API Costs Per Query Type

| Query Type | APIs Called | Est. Cost Per Query | Typical Calls Per Plan |
|---|---|---|---|
| Demographics / Payer Mix | Anthropic + Census (free) | $0.08–0.15 | 1-2 |
| BH Location Inventory | Anthropic + Yext (free) + Google Distance Matrix | $0.10–0.20 | 1-2 |
| BH Physician Inventory | Anthropic + Yext (free) + Google Distance Matrix | $0.12–0.25 | 1-2 |
| Competitor Landscape | Anthropic + Google Places | $0.08–0.15 | 1-2 |
| Reviews Deep Dive | Anthropic + Outscraper | $0.15–0.50 | 0-1 |
| Drive Time Isochrone | Anthropic + ORS (free tier) | $0.05–0.10 | 0-1 |
| Web Research | Anthropic + OpenAI | $0.10–0.20 | 1-2 |
| Psychographic Profiling | Anthropic + Census (free) + OpenAI | $0.12–0.20 | 0-1 |

### Cost Per API

| API | Pricing Model | Est. Cost Per Plan |
|---|---|---|
| **Anthropic (Claude Sonnet)** | $3/M input, $15/M output tokens | $0.60–1.50 |
| **Yext** | Free (Live API, existing BH account) | $0.00 |
| **Census** | Free (government API) | $0.00 |
| **Google Maps Platform** | Geocoding $5/1K, Distance Matrix $5/1K elements, Places $17/1K | $0.10–0.30 |
| **OpenAI (gpt-4o)** | $2.50/M input, $10/M output | $0.05–0.15 |
| **Outscraper** | $2/1K reviews | $0.04–0.20 |
| **OpenRouteService** | Free tier (500 req/day) | $0.00 |

### Total Estimated Cost Per Marketing Plan

| Scenario | Queries | Est. Total Cost |
|---|---|---|
| **Light plan** (demographics + locations + competitors) | 3-4 queries | **$0.50–1.00** |
| **Standard plan** (all data types, no reviews) | 6-8 queries | **$1.00–2.50** |
| **Deep plan** (all data types + reviews + isochrones) | 8-12 queries | **$2.00–4.00** |

**Monthly estimate:** 10 plans/month × $2.50 avg = **~$25/month** in API costs.

**Comparison to n8n:** n8n added $24-50/month subscription cost on top of API costs. Now eliminated.

---

## 12 BH Consumer Segments

| Segment | Who They Are | Marketing Target? |
|---|---|---|
| Stable and Seeking Care | Largest, highest commercial, Primary Care entry | **YES** |
| Pinterest and Planning | Younger women, commercial, health-conscious, digital-first | **YES** |
| Brickell Briefcase | Urban professionals 25-40, employer insurance, convenience-driven | **YES** |
| Empty Nests, Full Pockets | Affluent seniors, active, musculoskeletal, high digital | **YES** |
| Settling Down | Young married men, need PCP, partner-influenced | **YES** |
| Snowbird Circuit | Seasonal affluent 60+, concierge demand | **YES** |
| Mi Familia Primero | Hispanic/Latino multigenerational, bilingual, community trust | Operational |
| Babies and Bills | Young women, Medicaid, high maternity | Operational |
| Weekend Warriors | Single men, Medicaid, ED entry, trauma | Operational |
| One Day at a Time | Middle-age, metabolic syndrome, high clinical need | Operational |
| Senior Discounts | Older Medicare, highest chronic burden | Operational |
| Grit and Grind | Blue-collar, uninsured, ED entry, price-sensitive | Operational |

---

## Verified Test Results (April 20, 2026)

| Test | Result | Key Validation |
|---|---|---|
| Mile-based radius | ✅ PASS | 2 locations within 5 mi, correct distances |
| Physician by specialty | ✅ PASS | 11 ortho at Miami Gardens (8.4 mi), all 9 cities searched |
| Demographics | ✅ PASS | Correct percentages, 6 sections, commercially addressable pop |
| Context-aware (overlap/feeder) | ✅ PASS | Correct geocoding, accurate drive times, proper classification |
| Deployed (Replit) | ✅ PASS | Same results as localhost |

---

## Known Limitations

- Sonnet sometimes includes locations slightly outside stated radius
- Physician search depends on city adjacency map — unlisted cities use model's geographic knowledge
- No ZIP filter for physicians — use city + drive time
- Sub-specialty physicians (Breast, Maternal-Fetal, etc.) not in Yext
- Model is claude-sonnet-4-20250514 (deprecated EOL June 15, 2026)
- Client-side Yext pre-load exposes API key in browser (needs proxy)

---

## To Continue

1. Open Claude Code from `~/Desktop/Claude/MRA-v1.1-UI/`
2. `CLAUDE.md` provides full context automatically
3. `node server.js` → http://localhost:5000
4. Refresh browser between tests to clear cache
