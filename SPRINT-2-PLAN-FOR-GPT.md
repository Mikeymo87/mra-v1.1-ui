# MRA Sprint 2 Plan — For GPT Review

> **Context:** We completed Sprint 1 hardening (tool envelopes, server-side validations, modular prompts, intent router, SQLite ledger, Census cache, reasoning-based workflow prompts). You reviewed it and recommended evidence contracts, plan-type detection, trade area workflow, router tightening, and Census pre-seeding. This is our implementation plan for Sprint 2. We want your input before we build.

---

## What We're Planning to Build

### 1. Plan-Type Detection + Core Prompt Lens

Add plan-type detection to the intent router:

```javascript
function detectPlanType(query) {
  if (/facility\s*open|new\s*(facility|center|clinic)|opening\s*date/i.test(q)) return 'facility_opening';
  if (/partnership|affiliation|referral\s*network|one\s*medical/i.test(q)) return 'partnership_launch';
  if (/service\s*line|expansion|grow.*service|expand/i.test(q)) return 'service_line';
  if (/brand|system\s*(plan|wide)|awareness\s*campaign/i.test(q)) return 'brand_system';
  return 'unknown';
}
```

Add a plan-type lens to the core prompt:

```
Before selecting tools, identify the plan type:
- Facility Opening: address-based. Define trade area. Assess BH + competitor presence for every service line the facility offers.
- Service Line Plan: service-line focused. Assess physician supply, competitor strength, demand signals, commercial population.
- Partnership Launch: partner-site network. Map partner locations → BH specialty nearby → referral corridors.
- Brand/System Plan: market-wide. Summarize BH footprint, competitive positioning, geographic coverage.
```

The plan type changes how every workflow behaves without needing separate workflow files per plan type.

---

### 2. Evidence Contracts in Workflow Prompts

Add "MINIMUM EVIDENCE REQUIRED" and "WHAT NOT TO CONCLUDE" to each workflow.

**Competitive workflow example:**

```
MINIMUM EVIDENCE REQUIRED:
- Geocoded the target address
- Searched BH locations for every service line mentioned in the query
- Searched competitors for every service line mentioned in the query
- If "multi-specialty" mentioned: at minimum PC, UC, and every named service line
- If partnership context: checked partner locations
- Calculated drive times for key locations
If any required evidence was not gathered, state what was not searched and label analysis incomplete.

SEARCH COVERAGE — MANDATORY OUTPUT:
At the end of every competitive analysis, include:
  BH searched: [list]
  Competitors searched: [list]
  Not searched: [list, with reason]
  Geography: [radius and origin]

WHAT NOT TO CONCLUDE:
- Don't claim "BH has no presence" unless you searched that service line
- Don't call a competitor "weak" on rating alone if review count is under 50
- Don't infer market demand from Google ratings
- Don't treat a search coverage gap as a finding
```

Similar contracts for demographics, physicians, and location workflows.

---

### 3. Trade Area Definition Workflow

New workflow that fires when a user provides an address but no ZIP list:

1. Geocode address
2. Generate drive-time isochrone (15-min default)
3. Identify ZIPs within the polygon
4. Present proposed ZIP list with caveat ("ZIPs approximate a drive-time trade area, not a precision boundary")
5. Proceed with full analysis using those ZIPs

Trigger: Section 5 demographic query with address but no ZIPs detected → auto-add trade_area intent.

---

### 4. Fix Specialty Synonym Mapping

Current: "primary care" maps to only "Internal Medicine" — misses Family Medicine.

Fix: Support array mappings:
```javascript
'primary care': ['Internal Medicine', 'Family Medicine'],
'pcp': ['Family Medicine', 'Internal Medicine'],
```

When the mapped value is an array, run a Yext call for each and merge results.

---

### 5. Tighten Intent Router

Current problem: Section 4 competitive query loaded `["competitive","demographics","psychographic"]` because "marketing plan" trigger auto-adds demographics + psychographic. Psychographic workflow wasn't needed.

Fix: Only auto-add psychographic when the query specifically asks for segments/behaviors. Section 5 gets both. Section 4 gets demographics context only if needed.

---

### 6. Server-Side Distance Pre-Filtering (Token Optimization)

The Section 4 competitive query used 198K input tokens because 5 Yext calls × 50 results each = 250 facilities passed to Claude, most nowhere near the target.

Fix: After geocoding, store origin coordinates. When Yext/Places results come back, calculate haversine distance from origin to each result. Strip results outside 2x the stated radius before passing to Claude.

Expected impact: 250 records → 20-30 relevant ones. 40-60% input token reduction on location-heavy queries.

---

### 7. Pre-Seed Census Cache

Script that hits Census API for all 195 South Florida ZIPs with the 4 most common variable sets:
1. Population + age distribution (DP05)
2. Income, education, language, housing (DP02/DP03/DP04)
3. Payer mix — commercial/uninsured (DP03)
4. Payer mix — Medicare/Medicaid (Subject Tables)

~780 API calls with 500ms delay. Takes ~7 minutes. After this, Census data serves instantly from cache even during government outages.

---

### 8. Scenario Tests

6 real Marketing Plan GPT prompts as automated tests:
1. Section 5 demographics (facility opening) → verify Census + CDC called, no Yext
2. Section 4 competitive (multi-specialty) → verify BH searched for ALL mentioned service lines
3. Section 4 competitive (cardiology only) → verify Cardio-specific search
4. Section 5 with address but no ZIPs → verify trade area workflow fires
5. Physician query (Pembroke Pines) → verify all 9 adjacent cities searched
6. Partnership launch (One Medical) → verify partner locations + BH specialty mapping

---

## Marketing Plan GPT Changes (Documented, Not Building Yet)

These need to happen in a separate session to match MRA's new capabilities:

### A. Updated MRA invoke templates (ai-mra-invoke-CURRENT.md)

Every MRA prompt template should include:
- **Plan type** explicitly
- **Service lines** explicitly listed
- **Address + city**
- **Radius**

New structured format:
```
MRA Request
Plan type: [Facility Opening / Service Line Plan / Partnership Launch]
Section: [number — description]
Facility/Service: [name]
Address: [address, city, FL ZIP]
Service lines: [list every service line]
Radius: [X miles or minutes]
Need: [what data is needed]
Full data.
```

### B. Section 2 should use MRA as primary data source

Currently: Brand Tracker recommended for Section 2, MRA optional.
Proposed: MRA recommended for local market reality (competitive density, BH footprint, health behaviors), Brand Tracker recommended for perception layer (brand funnel, service line preference, perception attributes).

Both feed Section 2, but they answer different questions:
- MRA: "What's actually on the ground?" (ratings, presence, demographics, health behaviors)
- Brand Tracker: "What do consumers believe?" (perception, preference, awareness trends)

New Section 2 MRA template:
```
For Section 2 of the marketing plan.
Plan type: [type]
Facility/Service: [name] at [address, city]
Service lines: [list]

Market context for this trade area: competitive density and ratings for [service lines] within [radius], BH's existing footprint, health behaviors and demand signals from CDC data for [ZIPs], any recent competitive moves. Full data.
```

### C. Brand Tracker invoke doc — add reliability warning

Service line preference data is unreliable from the current Custom GPT (it struggles with the 17×18 brand grid on slide 19). Add to confirmed capabilities table:
```
| Service line preference | WEAK — VERIFY | GPT struggles with 17×18 grid; cross-check numbers against PDF |
```

### D. Trade area definition step before Section 5

When the GPT generates a Section 5 prompt and user hasn't provided ZIPs:
1. Ask: "Do you know the trade area ZIPs, or should MRA define them?"
2. If no → generate a trade area MRA prompt first
3. Use returned ZIPs in the full Section 5 prompt

---

## Design Philosophy: MRA as General-Purpose Research Tool

The MRA is NOT limited to marketing plan workflows. It's a market research agent that happens to serve marketing plans as its primary use case today. It also needs to handle:
- "Pull reviews for Memorial Pembroke Pines"
- "What BH cardiologists are near Weston?"
- "Compare payer mix for 33131 vs 33027"
- "What competitors are near a proposed site?"

All queries stay independent (no session reuse). Census cache + CDC local data handle repeated geographic lookups. Yext and Google Places always fresh. Server-side distance filtering reduces token waste.

---

## Questions for You

1. **Evidence contracts in prompts vs. code:** We're putting the evidence contracts in prompt text ("MINIMUM EVIDENCE REQUIRED"). You suggested also enforcing in code/tests. For Sprint 2, is prompt-only sufficient to ship, with code enforcement in Sprint 3? Or is prompt-only too fragile for a tool people depend on?

2. **Plan-type detection accuracy:** Our regex-based detector covers the 4 plan types. But what about queries that don't mention a plan type at all (ad-hoc research questions like "pull reviews for Memorial")? Should `unknown` plan type just skip the plan-type lens entirely and let the agent reason freely?

3. **Trade area definition — auto-proceed or confirm?** When the agent defines a trade area from an address, should it auto-proceed with analysis (faster, less friction) or show the proposed ZIPs and wait for confirmation (safer, but adds a round-trip)? For 1-3 known users, which is better?

4. **Distance pre-filtering — what radius buffer?** We're proposing 2x the stated radius as the filter cutoff (3-mile query → keep within 6 miles). Is that too aggressive? Too loose? Should it vary by query type (competitive might want tighter, physician might want looser)?

5. **Section 2 — MRA + Brand Tracker together:** We're proposing both tools for Section 2. Does this create confusion for the marketing lead (two separate queries, two responses to paste back)? Should we sequence them (MRA first for ground truth, Brand Tracker second for perception overlay)? Or is the current "Brand Tracker only for Section 2" actually fine and we're overcomplicating it?

6. **What are we missing?** Given everything you've seen about the system, the marketing plan workflow, and the changes we're planning — what would you add, remove, or change about this sprint plan?

---

*Sprint 2 plan — April 27, 2026*
*MRA v3 (post-hardening), targeting evidence contracts + plan-type intelligence*
