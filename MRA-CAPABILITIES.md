# BH Market Research Agent — Capabilities & Prompt Reference

## What It Is
A Claude Sonnet-powered research agent with 10 tools (9 live APIs + 1 local dataset). It answers data questions about Baptist Health South Florida's market — demographics, psychographics, health behaviors, locations, physicians, competitors, reviews, and drive times. It does NOT make strategic recommendations. It reports verified data.

**Endpoint:** `POST /api/chat` (SSE streaming) or `POST /webhook/market-research` (JSON)

---

## Tool Inventory

### 1. Baptist Health Location Lookup (Yext)
- **What:** All BH facilities — 396 open entities across 19 categories
- **Categories (verified Yext keywords):**
  - Primary Care (46) | Urgent Care / Same-Day Care (~30) | Urgent Care Express (6)
  - Hospital (73) | Emergency (16, off-campus ED)
  - Imaging (50) | Sleep (7) | Endoscopy (11) | Surgery (22+)
  - Physical Therapy (13) | Rehabilitation (17) | Infusion (9) | Pharmacy (6) | Concierge (11)
  - Cardio (24) | Vascular (15) | Orthop (30+) | Neuro (27) / Spine (22) | Cancer (28)
  - Urology (17) | Gastro (4) | Gynecology (3) | Women (5) | Institute (28)
- **Returns:** name, address, coordinates, open/closed status
- **Limit:** 50 per call. Use keyword filters to stay under cap.

### 2. Baptist Health Physician Lookup (Yext)
- **What:** 7,569 BH physicians searchable by specialty and city
- **Filter field:** `c_listOfSpecialties` (NOT `c_specialty`)
- **Specialty keywords (partial match):**
  Cardio (359) | Vascular (120) | Orthop (285) | Neuro (468) | Oncol (373) | Family Medicine (277) | Internal Medicine (610) | Gastro (246) | Urolog (137) | Pulmon (100) | Dermatol (72) | OB (384) | Pediatr (626) | Emergency (646) | Surgery (770) | Pain (102) | Endocrin (102) | Ophthalmol (217) | Radiol (363) | Psychiatr (63) | Rheumat (18)
- **Geographic filter:** `address.city` (works) — always combine with specialty to stay under 50 limit
- **Returns:** name, specialty list, degrees (MD/DO), address, coordinates, phone, languages, NPI, accepting new patients, rating, review count, office name
- **Note:** "Primary Care" returns 0 — use "Family Medicine" or "Internal Medicine" instead

### 3. Census Demographics Lookup
- **What:** US Census ACS 5-Year data — population, age, income, insurance, education, foreign-born, housing
- **Endpoints:** Detailed Tables, Data Profiles (/profile), Subject Tables (/subject)
- **Max 25 variables per call.** Split into multiple calls if needed.
- **Auto-retry:** If 2024 data fails, automatically falls back to 2023.
- **Key variables for marketing plans:**
  - Population: DP05_0001E
  - Age bands: DP05_0005E through DP05_0017E
  - Median HHI: DP03_0062E
  - Private insurance: DP03_0097E/PE
  - Uninsured: DP03_0099E/PE
  - Medicare: S2704_C02_002E (Subject Tables)
  - Medicaid: S2704_C02_006E (Subject Tables)
  - Foreign-born: DP02_0113PE
  - Bachelor's+: DP02_0068PE

### 4. Geocode Address (Google)
- **What:** Converts street address to lat/lng coordinates

### 5. Calculate Drive Times (Google Distance Matrix)
- **What:** Real drive times AND distances between coordinates
- **Units:** Imperial (miles, minutes)
- **Max:** 25 origins × 25 destinations per call
- **Returns:** duration (text + seconds) AND distance (text in miles + meters)

### 6. Competitor Ratings (Google Places Text Search)
- **What:** Quick competitor snapshot — stars, review count, address, place_id
- **Max:** 5 competitor locations per query

### 7. Google Reviews Deep Pull (Outscraper)
- **What:** Full review text, dates, business responses, sentiment
- **Max:** 10 locations per batch, up to 100 reviews per location
- **Use for:** Theme analysis, name extraction, sentiment trends

### 8. Web Research (OpenAI gpt-4o)
- **What:** Live web search for market trends, Esri Tapestry segments, competitor news
- **Use for:** Anything not in structured APIs — news, market reports, demographic context

### 9. Drive Time Isochrone (OpenRouteService)
- **What:** GeoJSON drive-time polygons (5, 10, 15, 20 min rings)
- **Format:** Coordinates are [longitude, latitude]
- **Max:** 3 ranges per call

### 10. CDC Health Behaviors (Local Data — CDC PLACES 2025)
- **What:** 33 health behavior and lifestyle measures per ZIP code. Real behavioral data from BRFSS surveys.
- **Coverage:** 195 ZIPs across Miami-Dade (~78), Broward (~51), Palm Beach (~57), Monroe (~9)
- **Key measures:**
  - Healthcare engagement: Annual checkup, dental visit, cholesterol screening, mammography, colon screening
  - Lifestyle behaviors: Physical inactivity, obesity, smoking, binge drinking, short sleep
  - Mental health: Depression diagnosis, frequent mental health distress
  - Chronic disease prevalence: Diabetes, high blood pressure, high cholesterol, heart disease, COPD, stroke, cancer
  - Access: Uninsured rate (18-64)
  - Disabilities: Mobility, cognitive, self-care, independent living
- **Latency:** Zero (local JSON file, no API call)
- **Use with:** Census demographics to build complete psychographic profiles. CDC provides behavioral evidence; Census provides demographic context. Together they enable accurate BH audience segment scoring.

---

## Radius Support

The agent handles BOTH distance and drive-time radii:
- **"within 15 minutes"** → filters by Google Distance Matrix duration
- **"within 5 miles"** → filters by Google Distance Matrix distance (imperial)
- **"within 5 miles or 20 minutes"** → includes if EITHER condition met
- **No radius specified** → defaults to 15-minute drive time

---

## How the Marketing Plan GPT Should Use the MRA

**The Marketing Plan GPT is the strategist. The MRA is the data engine.**

The MRA does not know what section of the marketing plan you're building. It does not know what data you need next. It answers exactly what you ask — nothing more, nothing less.

**The Marketing Plan GPT must decide:**
1. What section of the plan it's currently building (e.g., Market Assessment, Competitive Landscape, Audience Definition)
2. What data that section requires
3. Which MRA prompt template below to use
4. How to interpret the MRA's response and weave it into the plan narrative

**Do NOT send the MRA vague strategic questions** like "tell me about this market" or "what should we know about Pembroke Pines." Send it specific, structured data requests using the templates below. The MRA will return structured data tables. The Marketing Plan GPT interprets what it means strategically.

**Typical plan-building sequence:**
1. **Trade Area Definition** → Ask MRA for demographics + payer mix by ZIP
2. **BH Network Assessment** → Ask MRA for all BH locations within radius, classified by service line
3. **Competitive Landscape** → Ask MRA for competitor locations + ratings via Google Places
4. **Physician Network** → Ask MRA for BH physicians by specialty within radius
5. **Audience Cohorts** → Ask MRA for psychographic profiling of the trade area ZIPs
6. **Reviews/Sentiment** → Ask MRA for Google reviews deep pull on key BH + competitor locations

Each step is a separate MRA query. Do not combine them.

---

## Ideal Prompt Structure

### Demographics / Payer Mix
```
Demographic profile and payer mix for ZIPs 33027, 33028, 33029: population, age distribution, income, commercial vs government insurance by ZIP, foreign-born percentage, language.
```
- Keep to ONE data type per query (demographics only, no locations mixed in)
- Always specify ZIPs — the agent pulls real Census data, not estimates
- Agent returns 6 structured sections: Trade Area Overview, Population by ZIP, Age Distribution (with commercially addressable population 18-64), Payer Mix by ZIP (with commercial % flags), Language & Cultural Context, Marketing Implications
- The #1 output is **commercially addressable population** (ages 18-64 with commercial insurance)

### BH Location Inventory
```
All Baptist Health primary care, urgent care, imaging, and specialty locations within 10 miles of [ADDRESS] — name, care type, address, and distance.
```
- Specify care types OR say "all locations"
- Include radius (miles or minutes)
- Include origin address

### BH Physician Inventory
```
All Baptist Health [SPECIALTY] physicians within [RADIUS] of [ADDRESS/FACILITY] — name, specialty, degrees, office, drive time, accepting new patients.
```
- Use the specialty keywords listed above (Cardio, Orthop, Neuro, etc.)
- Always include a geographic anchor

### Competitor Landscape
```
All urgent care, primary care, and [SPECIALTY] clinics within [RADIUS] of [ADDRESS] — name, system, stars, review count, address.
```
- The agent uses Google Places, not Yext — returns ALL providers, not just BH

### Reviews Deep Dive
```
Pull the 50 most recent Google reviews for [FACILITY NAME + CITY + STATE]. Analyze themes, sentiment, and any recurring complaints.
```

### Drive Time / Distance
```
Drive times from [ORIGIN] to [LIST OF DESTINATIONS].
```

### Isochrone / Trade Area
```
Generate 5, 10, and 15 minute drive-time polygons from [ADDRESS] as GeoJSON.
```

### Context-Aware (for new facility planning)
```
What BH locations would be relevant to a new [FACILITY TYPE] at [ADDRESS] offering [SERVICE LINES]? Show all BH assets within [RADIUS] classified as overlap (same services) or feeder (referral source).
```
- User MUST provide the service lines — the agent will ask if not stated

---

## What the MRA Cannot Do
- **No strategy** — it reports data, does not recommend actions
- **No cross-query correlation** — each query is independent; it won't automatically combine demographics with location data unless explicitly asked
- **No historical trends** — Census is a snapshot, not longitudinal
- **No financial projections** — no revenue, volume, or ROI modeling
- **No internal BH data** — only public APIs (Yext, Census, Google, Outscraper)
- **Physician lookup has no ZIP filter** — use city filter + drive time calculation instead

---

## Payer Mix Rule (Critical)
All marketing analysis targets commercially insured patients (ages 18-64) ONLY. Medicare/Medicaid patients come organically. The agent will:
- Frame opportunity through commercial insurance penetration
- Report government payer data as operational context, not marketing targets
- Never recommend spending marketing dollars on Medicare/Medicaid populations
- Use 40%+ commercial insurance as the viability KPI

---

## 12 BH Audience Segments
The agent scores these using Census proxy variables. Commercially insured segments are marketing targets; government-payer segments are operational context only.

**Marketing targets:** Stable and Seeking Care | Pinterest and Planning | Brickell Briefcase | Empty Nests Full Pockets | Settling Down | Snowbird Circuit
**Operational context (no marketing spend):** Babies and Bills | Weekend Warriors | One Day at a Time | Senior Discounts | Mi Familia Primero | Grit and Grind

---

## Critical Rules for the Marketing Plan GPT

1. **One data type per MRA query.** Don't ask for demographics AND locations in the same prompt. Split them.
2. **Always include geography.** Every MRA query needs an address, ZIP, or facility name as anchor.
3. **Always include radius.** Specify miles or minutes. If not specified, MRA defaults to 15-minute drive time.
4. **Always include the city name** in any address. South Florida has duplicate street addresses across cities (e.g., "1400 SW 145th Ave" exists in both Miami and Pembroke Pines, 17 miles apart).
5. **The MRA reports data. You interpret it.** Don't ask the MRA "what should we do?" Ask it "what's there?" Then YOU decide what it means for the plan.
6. **Verify the Sources section.** Every MRA response ends with a Sources block. If a data point isn't traceable to a listed source, don't trust it.
7. **Payer mix is the lens.** Every audience, geography, and targeting decision filters through commercially insured patients ages 18-64. The MRA enforces this automatically.
8. **Context-aware queries require service lines.** When asking about a new facility, always state what services it will offer so the MRA can classify existing locations as overlap vs. feeder.
