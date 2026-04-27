# BH Market Research Agent — v3 Hardening Review

> **Purpose:** This is a follow-up handoff after implementing your recommendations from the initial review. We made significant changes and have new questions. We want your honest re-assessment: what's better, what's still wrong, and what should we do next.

---

## 1. WHAT CHANGED SINCE YOUR LAST REVIEW

Based on your initial review, we implemented these changes in a single session:

### A. Tool Result Envelopes (your Severity 1 recommendation)
Every tool response now returns a structured envelope:
```json
{
  "_source": { "api": "...", "url": "...", "retrieved_at": "..." },
  "status": "success | partial | empty | failed",
  "result_count": 12,
  "warnings": ["Fell back from 2024 to 2023", "CITY MISMATCH: input 'miami' but geocoded to 'miami lakes'"],
  "query": { "endpoint": "...", "filter": "..." },
  "data_year": "2023",
  "data": [...]
}
```
The old `cite()` function is gone. Every tool now carries machine-readable status, warnings, query metadata, and data year. The system prompt tells the agent to use this metadata — surface warnings, cite data_year, report failures honestly.

### B. Server-Side Validations (moved from prompt to code)
- **Geocode city verification:** Server extracts locality from Google's `address_components`, compares to input city. Adds `CITY MISMATCH` warning if they differ. Warns but doesn't block (because "Miami Lakes" vs "Miami" shouldn't hard-fail).
- **Census percentage calculations:** When B01001 age/sex variables are returned, server computes `_PCT` columns using total population as denominator. Claude sees pre-calculated percentages instead of computing them itself.
- **Specialty synonym map:** 30+ colloquial-to-Yext mappings in code (e.g., "heart doctor" → "Cardio", "primary care" → "Internal Medicine", "diabetes doctor" → "Endocrin"). Applied before Yext API call. Warning added: `"Mapped specialty synonym: 'heart doctor' → 'Cardio'"`.
- **City alias map:** 12 South Florida city abbreviation/variant mappings (e.g., "Ft Lauderdale" → "Fort Lauderdale", "hallandale" → "Hallandale Beach"). Applied in geocode and physician executors.

### C. Modular System Prompt + Intent Router (your "split the 41K prompt" recommendation)
The monolithic 41K-char system prompt is now split into 8 files:
- `prompts/core.txt` — identity, anti-hallucination, citation rules, routing table, response format (10K chars)
- `prompts/workflow-demographics.txt` — Census workflow, payer mix, age/sex, payer targeting rule
- `prompts/workflow-locations.txt` — BH location analysis
- `prompts/workflow-physicians.txt` — Physician search with city adjacency map
- `prompts/workflow-competitive.txt` — Competitive landscape analysis
- `prompts/workflow-psychographic.txt` — 3-layer profiling (Census + CDC + Esri)
- `prompts/workflow-facility-planning.txt` — Context-aware facility analysis
- `prompts/reference-data.txt` — Yext keywords, competitors, One Medical, market territory

A keyword-based `classifyIntent(query)` function routes queries to the right workflow(s). Reference data always loads. Fallback loads all workflows if no intent matches.

**Measured token savings:**
| Query Type | Old Prompt | New Prompt | Savings |
|---|---|---|---|
| Demographics only | 41K chars | 22K chars | 46% |
| Physician search | 41K chars | 18K chars | 56% |
| Competitive only | 41K chars | 15K chars | 63% |
| Full plan mode | 41K chars | 31K chars | 24% |

### D. SQLite Run Ledger (your auditability recommendation)
Every run is logged to `data/mra-ledger.db`:
- `runs` table: session_id, user_query, detected intents, iterations, input/output tokens, estimated cost, final response
- `tool_calls` table: tool_name, input_params, status, result_count, warnings, duration_ms, raw_result_chars

Example ledger output:
```
| Query | Intents | Iterations | Input Tokens | Output Tokens | Cost |
| Demographics for 33027 | ["demographics"] | 3 | 31,918 | 2,055 | $0.13 |
| Section 5 full demo+psycho | ["demographics","psychographic"] | 4 | 78,435 | 5,477 | $0.32 |
| Section 4 competitive | ["competitive","demographics","psychographic"] | 4 | 198,914 | 3,361 | $0.65 |
```

### E. Census Cache (added after discovering reliability issue)
Census API calls are cached to `data/census-cache.json` on success. If Census goes down, cached data is served with a warning: `"Census API unavailable — serving cached data from X days ago"`. Cache valid for 90 days (Census data is annual). Timeout reduced from 60s to 20s (fail fast, don't leave user waiting).

### F. Security Fixes
- **Yext API key removed from client-side HTML.** Moved to server-side proxy endpoint (`GET /api/yext-preload`).
- **Basic auth middleware** available (disabled by default, enabled via `MRA_USERNAME`/`MRA_PASSWORD` in `.env`).
- **Per-session rate limiting:** 30 queries/hour.

### G. Regression Tests
32 automated tests covering intent classification, city normalization, specialty synonyms, envelope status logic, and prompt builder output. All passing.

---

## 2. THE BIGGEST CHANGE: REASONING-BASED WORKFLOW PROMPTS

Your initial review said: *"The agent should reason. The code should verify."*

We took this further. The original workflow prompts were step-by-step checklists ("do step 1, then step 2, then step 3"). The agent followed them blindly without understanding WHY.

**Example of the problem:** For a Section 4 competitive analysis of a multi-specialty medical center, the agent only searched BH's urgent care and primary care presence — because the checklist didn't say "search cardiology, orthopedics, and imaging too." It produced a confident, well-formatted response that said "BH has zero specialty presence in this area" — without ever checking. That's the "silent wrongness" you warned about, caused by checklist-following instead of reasoning.

**What we changed:** Every workflow prompt now starts with "YOUR ROLE" and "HOW TO THINK ABOUT IT" instead of "STEP 1, STEP 2, STEP 3." The agent is taught to reason from the query context:

- **Competitive workflow:** "Before searching competitors, identify what you're analyzing. A multi-specialty center? Check competitors AND BH presence across every relevant service line. An urgent care? Focus on UC and PC."
- **Location workflow:** "Determine scope from context. A multi-specialty opening needs different searches than a simple 'what's nearby.'"
- **Physician workflow:** "If the query is about a facility opening with multiple service lines, don't just search the one specialty the user named."
- **Facility planning:** "Think in terms of overlap, feeder, and gap. Classify everything through the lens of this specific facility."

**Measured result:** Same Section 4 competitive query, before and after:

| Metric | Before (checklist) | After (reasoning) |
|---|---|---|
| BH Yext searches | 2 (PC, UC only) | **5** (PC, UC, Cardio, Orthop, Imaging) |
| Competitor searches | 1 (generic) | **5** (UC, PC, ortho, cardio, imaging) |
| Service lines analyzed | 0 specialty | **4** (cardio, ortho, imaging, UC/PC) |
| Identified weak competitors | 0 | **3** (All-Pro 3.4 stars, FL Institute Cardio 3.7, displaceable) |
| One Medical feeder identified | No | **Yes** |

---

## 3. WHAT THE SYSTEM LOOKS LIKE NOW

```
Browser (Chat UI)
    ↓ POST /api/chat (SSE)
Express.js Server (server.js)
    ↓ Basic auth + rate limiting
    ↓ classifyIntent(query) → load relevant workflow prompts
    ↓ Core prompt + workflow(s) + reference data
Claude Sonnet 4.6 (tool_use mode, max 25 iterations)
    ↓ Reasons about query context → decides tools
11 Tool Executors
    ↓ Each returns structured envelope (status, warnings, metadata)
    ↓ Census: 20s timeout → cache fallback → percentage pre-calculation
    ↓ Geocode: city verification in code
    ↓ Physicians: synonym + city alias normalization
    ↓ Distance Matrix: flattened into explicit pairs
SQLite Ledger (every run + tool call logged)
    ↓ Cost tracking, auditability
Session compression (full data → 2K summary after processing)
    ↓ SSE stream to browser
User sees markdown response with sources
```

---

## 4. LIVE TEST RESULTS

We tested with real Marketing Plan GPT prompts — the exact format the GPT generates for users to paste into MRA.

### Test: Section 5 — Full Demographics + Psychographics (5 ZIPs)
**Prompt:** "For Section 5 of the marketing plan. Facility Opening: Multi-Specialty Medical Center at 18503 Pines Blvd, Pembroke Pines FL 33029. Target: Commercially insured adults 25-64. Full demographic and psychographic analysis for ZIPs 33027, 33028, 33029, 33025, 33026..."

**Result:** 4 Census calls + CDC health behaviors + 3 web research calls. Complete 6-section output with trade area overview, population by ZIP, age distribution, payer mix with commercial flags, CDC health behaviors (preventive care, chronic disease, mental health), segment scoring with behavioral evidence. All data verified, sources cited. Cost: $0.32.

### Test: Section 4 — Competitive Landscape (after reasoning fix)
**Prompt:** "For Section 4 of the marketing plan. Facility Opening: Multi-Specialty Medical Center at 18503 Pines Blvd, Pembroke Pines FL 33029. Full competitive picture within 3 miles..."

**Result:** 5 BH Yext searches (PC, UC, Cardio, Orthop, Imaging) + 5 Google Places searches (UC, PC, ortho, cardio, imaging) + geocode + drive times. Output organized by service line (4A through 4G), competitive positioning map, BH footprint gap analysis, One Medical feeder identified, weak competitors flagged as displaceable. Cost: $0.65.

---

## 5. OPEN QUESTIONS FOR YOUR RE-REVIEW

### Question 1: Plan-Type Agnosticism
Right now the workflow prompts still lean toward "facility opening" scenarios. But marketing plans come in 4 types:
- **Service Line Plan** — growing an existing service (e.g., expand cardiology in Broward)
- **Facility Opening** — new building, new address
- **Partnership Launch** — e.g., Baptist Health replacing UHealth as One Medical's specialty referral network
- **Brand/System Plan** — system-wide awareness campaign

Each needs different data from MRA. A partnership launch needs: find all partner locations → map BH specialty nearby → build referral corridors. A service line expansion needs: where are our physicians thin, where are competitors strong, where's the commercial population.

**How should we teach the agent to adapt its reasoning to different plan types without creating 4 separate workflow sets?** Should the core prompt include a "plan type reasoning framework" that the agent applies to any workflow? Or should the intent router detect plan type and load different instructions?

### Question 2: Trade Area Definition Gap
The Marketing Plan GPT generates Section 5 prompts that assume the user already knows which ZIPs to analyze (e.g., "Full demographic analysis for ZIPs 33027, 33028, 33029..."). But how would a user know which ZIPs matter without first asking MRA?

We think there needs to be a "trade area definition" step before the full Section 5 query — something like "What ZIPs are within a 15-minute drive of [address]?" that uses isochrone or drive time data to identify the relevant ZIPs. Then the user runs the full demographics query with those ZIPs.

**Should this be built into MRA (auto-define trade area when it sees a Section 5 query with an address but no ZIPs)? Or should it stay as a separate query the GPT recommends first?**

### Question 3: Agent Reasoning vs. Prompt Checklists
We shifted from "step 1, step 2, step 3" prompts to "here's your role, here's how to think, now decide." This dramatically improved output quality (the competitive analysis went from 2 BH searches to 5, covering all relevant service lines).

But we're concerned about consistency. A checklist is predictable — the agent always does the same thing. Reasoning-based prompts mean the agent might make different choices on different runs. For a marketing plan tool where data accuracy matters, **how do we balance reasoning flexibility with output consistency?** Should we have "reasoning + minimum requirements" (e.g., "reason about what to search, but for any facility opening you MUST check at least: PC, UC, and every service line mentioned in the query")?

### Question 4: Census API Reliability
Census is a government API that can be slow or down. We added:
- 20s timeout (was 60s)
- File-based cache with 90-day TTL
- Fallback: serve cached data with warning when API is down

**Is this enough for a tool that marketing leads depend on during plan-building sessions?** Should we pre-seed the cache with all 195 South Florida ZIPs? Should we add a scheduled job that refreshes the cache weekly?

### Question 5: Token Cost at Scale
The Section 4 competitive query used 198K input tokens ($0.65). That's because it loaded 31K chars of system prompt AND received large tool results from 5 Yext searches + 5 Google Places searches.

If a full marketing plan requires 6-8 MRA queries, total cost is $2-4 per plan. At 10 plans/month that's $20-40. Acceptable, but the input token count is high.

**Where would you optimize? Smaller tool results? More aggressive compression? Fewer workflow prompts loaded? Or is $2-4/plan fine for the value delivered?**

### Question 6: Multi-Agent vs. Single Agent (Revisited)
With the modular prompts, we're getting 60-80% of multi-agent benefit. But the competitive analysis query still loaded `["competitive","demographics","psychographic"]` intents — meaning it got demographics and psychographic workflow text it didn't need for a competitive query.

The intent router is keyword-based and conservative (loads more than necessary rather than missing something). **Should we tighten it, or is over-loading acceptable? At what point does a thin orchestrator that makes a cheap classification call (Haiku) become worth the added complexity?**

### Question 7: The Marketing Plan GPT ↔ MRA Workflow
Right now it's manual copy-paste: GPT generates a pre-filled MRA prompt → user opens MRA in a browser tab → pastes query → copies response → pastes back into GPT.

This works but it's friction. The user has to context-switch between two tools. **What's the lightest-weight way to reduce this friction without building a full API integration?** Options we've considered:
- Embed MRA as an iframe in the GPT
- ChatGPT Custom Action calling MRA's `/webhook/market-research` endpoint
- Keep it as copy-paste but optimize the prompt templates so they're shorter and the responses are more directly usable

---

## 6. CURRENT ARCHITECTURE SUMMARY

| Component | Technology | What Changed |
|---|---|---|
| Frontend | Vanilla HTML/JS + marked.js | Yext key removed from client |
| Backend | Express + @anthropic-ai/sdk | Envelopes, validations, intent router, auth, rate limiting, Census cache |
| AI Model | Claude Sonnet 4.6 | Same model, smarter prompts |
| System Prompt | 8 modular files (was 1 monolith) | Reasoning-based workflows, intent routing |
| Database | SQLite (better-sqlite3) | NEW — run ledger + tool call logging |
| Cache | File-based JSON | NEW — Census query cache (90-day TTL) |
| Tests | 32 regression tests | NEW |

**Dependencies:** @anthropic-ai/sdk, express, dotenv, better-sqlite3 (4 total)
**Cost:** ~$25-40/month for 10 marketing plans
**Users:** 1-3 marketing leads (internal tool)

---

## 7. FILES

| File | Purpose |
|---|---|
| `server.js` | Express backend, 11 tool executors with envelopes, intent router, SQLite logging, Census cache, auth, rate limiting |
| `db.js` | SQLite schema and prepared statements |
| `prompts/core.txt` | Identity, rules, routing table, response format |
| `prompts/workflow-*.txt` | 6 workflow-specific prompt modules |
| `prompts/reference-data.txt` | Yext keywords, competitors, market territory |
| `public/index.html` | Chat UI (Yext key removed) |
| `data/mra-ledger.db` | SQLite run ledger |
| `data/census-cache.json` | Census query cache |
| `data/cdc-places-south-florida.json` | Local CDC health behavior data (195 ZIPs) |
| `data/one-medical-locations.json` | Local One Medical locations (7 clinics) |
| `test/regression.js` | 32 automated tests |
| `server-v2-backup.js` | Previous version (backup) |

---

*Generated 2026-04-27 for external architecture re-review after v3 hardening session.*
