# BH Market Research Agent — v2.1

## What This Is
Baptist Health South Florida Market Research Agent. A Claude Sonnet-powered chat app with 10 live API tools for demographics, BH locations, physicians, competitors, reviews, and drive times. Direct Anthropic SDK backend (no n8n).

## Architecture
- `server.js` — Express backend, Anthropic SDK with tool_use, SSE streaming, 9 tool executors
- `system-prompt.txt` — 35K char system prompt with 7 structured workflows
- `public/index.html` — Chat UI with SSE streaming, markdown rendering, cache-clear-on-refresh
- `MRA-CAPABILITIES.md` — Handoff doc for Marketing Plan GPT
- `.env` — 7 API keys (ANTHROPIC, YEXT, CENSUS, OPENAI, GOOGLE_MAPS, OUTSCRAPER, ORS) — never commit

## Running
```
cd ~/Desktop/Claude/MRA-v1.1-UI && node server.js
# → http://localhost:5000
# Refresh browser between tests to clear sessionStorage cache
```

## Deployed
- **Replit:** bh-market-research-agentv-111.replit.app
- **GitHub:** https://github.com/Mikeymo87/mra-v1.1-ui

## 10 Tools
1. Baptist Health Location Lookup (Yext) — 396 facilities, 19 categories
2. Census Demographics Lookup — 2024→2023 auto-fallback, max 25 vars/call
3. Web Research (Firecrawl search — returns titles, URLs, descriptions only. No full page content.)
4. Read Page (Jina Reader → Firecrawl /scrape fallback) — extracts full markdown from a URL. Use after web_research for the 1-2 URLs that need deep reading.
5. Geocode Address (Google) — MUST include city name (duplicate addresses in SoFla)
6. Calculate Drive Times (Google Distance Matrix) — flattened response, 10 destinations max per call
7. Competitor Ratings (Google Places Text Search)
8. Google Reviews Deep Pull (Outscraper)
9. Drive Time Isochrone (OpenRouteService)
10. Baptist Health Physician Lookup (Yext) — 7,569 physicians, filter: `c_listOfSpecialties` + `address.city`

## Critical Implementation Details

### Distance Matrix Flattening (server.js)
The `calculate_drive_times` executor pre-processes Google's nested `rows[].elements[]` into flat `{origin, destination, duration, distance}` objects. This prevents the model from misattributing which drive time belongs to which facility. Do NOT revert to raw Google response format.

### Truncation Limit (server.js)
`truncateResult` maxChars = 50000. Was 8000 in v1 which cut Distance Matrix JSON mid-array and caused hallucinated drive times. Do not lower this.

### Physician Filter Field
The correct Yext filter field for physicians is `c_listOfSpecialties` (NOT `c_specialty` — that returns API error). The correct credentials field is `degrees` (NOT `c_credentials` — doesn't exist).

### City Adjacency Map (system-prompt.txt)
Hardcoded map of 14 South Florida cities with adjacent cities for physician searches. Pembroke Pines requires searching 9 cities. The model will skip cities if this isn't marked MANDATORY.

### Geocoding (server.js + system-prompt.txt)
South Florida has duplicate street addresses across cities (e.g., 1400 SW 145th Ave exists in both Miami and Pembroke Pines, 17 miles apart). The geocode tool description warns about this. The system prompt requires city name verification after geocoding.

### Payer Targeting Rule
Dan's directive: marketing dollars target commercially insured patients (18-64) ONLY. Medicare/Medicaid come organically. The system prompt enforces this. Never weaken this rule.

### Session Cache (public/index.html)
`sessionStorage` cache is cleared on page load (line ~229). Without this, repeated queries serve stale cached answers instead of making fresh API calls. Do not remove the cache-clear.

## Yext Facility Keywords (verified, with entity counts)
Hospital (73) | Emergency (16) | Primary Care (46) | Urgent Care/Same-Day Care (~30) | Express (6) | Imaging (50) | Cardio (24) | Vascular (15) | Orthop (30+) | Neuro (27) | Spine (22) | Cancer (28) | Surgery (22+) | Endoscopy (11) | Physical Therapy (13) | Rehabilitation (17) | Infusion (9) | Pharmacy (6) | Sleep (7) | Concierge (11) | Urology (17) | Gastro (4) | Women (5) | Institute (28)

**Zero-result keywords (NOT in Yext):** Breast, Maternal, Palliative, Preventive, Colon, Colorectal, Pancreatic, Bariatric, Plastic, Dermatology, ENT, Allergy, Rheumatology, Wound, Pulmonary, Pain, Psychiatry, Specialty

## Physician Specialty Keywords (for c_listOfSpecialties filter)
Cardio (359) | Vascular (120) | Orthop (285) | Neuro (468) | Oncol (373) | Family Medicine (277) | Internal Medicine (610) | Gastro (246) | Urolog (137) | Pulmon (100) | Dermatol (72) | OB (384) | Pediatr (626) | Emergency (646) | Surgery (770) | Pain (102) | Endocrin (102) | Ophthalmol (217) | Radiol (363) | Psychiatr (63) | Rheumat (18)

**"Primary Care" returns 0 for physicians** — use "Family Medicine" or "Internal Medicine" instead.

## Known Limitations
- Sonnet sometimes includes locations slightly outside stated radius (21-22 min when asked for 20)
- Physician search depends on city adjacency map — unlisted cities fall back to model's geographic knowledge
- No ZIP filter for physicians — use city + drive time
- Sub-specialty physicians (Breast, Maternal-Fetal, etc.) not in Yext
- Model is claude-sonnet-4-6 (current)

## What's Next
- Marketing Plan GPT integration (handoff doc delivered)
- Add loading/thinking indicator to UI
- Remove client-side Yext pre-load (API key exposed in browser)
- Test competitor queries, reviews deep pull, isochrones
