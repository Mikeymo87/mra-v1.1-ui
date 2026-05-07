#!/usr/bin/env node
/**
 * refresh-permits.js — Automated Permit & Construction Tracker
 *
 * Discovers healthcare construction projects in BH's 4-county Primary Service Area
 * via Firecrawl search → Jina Reader → Claude Haiku extraction → SQLite upsert.
 *
 * Run: node scripts/refresh-permits.js
 * Or:  POST /api/refresh-permits (from n8n, bi-weekly Monday 9 AM)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const {
  db, insertPermit, updatePermit, touchPermit, getPermitById,
  insertPermitHistory, insertScraperRun, markStalePermits
} = require('../db');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Configuration ─────────────────────────────────────────────────────────────

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
const EXTRACTION_MODEL = 'claude-sonnet-4-6-20250514';

const COMPETITOR_SYSTEMS = {
  'Broward Health': ['Broward Health', 'North Broward Hospital District', 'NBHD'],
  'CHS': ['Community Health Systems', 'CHS'],
  'Cleveland Clinic Florida': ['Cleveland Clinic', 'CC Florida'],
  'HCA Florida': ['HCA Florida', 'HCA Healthcare', 'HCA', 'MD Now'],
  'Holy Cross / Trinity Health': ['Holy Cross', 'Trinity Health', 'Holy Cross Health'],
  'HSA': ['Health Systems of America', 'HSA'],
  'Jackson Health': ['Jackson Health', 'Jackson Memorial', 'Jackson Health System'],
  'Jupiter Medical Center': ['Jupiter Medical Center', 'Jupiter Medical'],
  'Keralty': ['Keralty'],
  'Lakeside / HCD PBC': ['Lakeside Medical', 'HCD PBC', 'Lakeside', 'Health Care District'],
  'Larkin': ['Larkin Health', 'Larkin Community Hospital', 'Larkin'],
  'Memorial Healthcare': ['Memorial Healthcare', 'Memorial Health', 'Memorial Regional'],
  'Mount Sinai': ['Mount Sinai Medical Center', 'Mount Sinai'],
  'Nicklaus Children\'s': ['Nicklaus', 'Nicklaus Children', 'NCH'],
  'Palm Beach Health / Tenet': ['Tenet Healthcare', 'USPI', 'Palm Beach Health Network', 'Tenet', 'Palm Beach Health'],
  'UHealth / University of Miami': ['UHealth', 'University of Miami', 'UM Health'],
  'UHS': ['Universal Health Services', 'UHS', 'Wellington Regional'],
  'Baptist Health Jacksonville': ['Baptist Health Jacksonville', 'Baptist Health (Jacksonville)'],
  'Baptist Health South Florida': ['Baptist Health South Florida', 'BHSF', 'Baptist Health']
};

// City → County mapping for South Florida PSA
const CITY_COUNTY_MAP = {
  'miami': 'Miami-Dade', 'miami beach': 'Miami-Dade', 'miami gardens': 'Miami-Dade',
  'miami lakes': 'Miami-Dade', 'miami shores': 'Miami-Dade', 'miami springs': 'Miami-Dade',
  'hialeah': 'Miami-Dade', 'homestead': 'Miami-Dade', 'coral gables': 'Miami-Dade',
  'doral': 'Miami-Dade', 'aventura': 'Miami-Dade', 'kendall': 'Miami-Dade',
  'cutler bay': 'Miami-Dade', 'palmetto bay': 'Miami-Dade', 'pinecrest': 'Miami-Dade',
  'key biscayne': 'Miami-Dade', 'north miami': 'Miami-Dade', 'north miami beach': 'Miami-Dade',
  'sunny isles': 'Miami-Dade', 'sunny isles beach': 'Miami-Dade', 'south miami': 'Miami-Dade',
  'sweetwater': 'Miami-Dade', 'medley': 'Miami-Dade', 'opa-locka': 'Miami-Dade',
  'fort lauderdale': 'Broward', 'hollywood': 'Broward', 'pembroke pines': 'Broward',
  'miramar': 'Broward', 'coral springs': 'Broward', 'davie': 'Broward',
  'plantation': 'Broward', 'sunrise': 'Broward', 'pompano beach': 'Broward',
  'deerfield beach': 'Broward', 'lauderhill': 'Broward', 'weston': 'Broward',
  'tamarac': 'Broward', 'margate': 'Broward', 'coconut creek': 'Broward',
  'lauderdale lakes': 'Broward', 'oakland park': 'Broward', 'wilton manors': 'Broward',
  'hallandale': 'Broward', 'hallandale beach': 'Broward', 'cooper city': 'Broward',
  'parkland': 'Broward', 'southwest ranches': 'Broward',
  'west palm beach': 'Palm Beach', 'boca raton': 'Palm Beach', 'delray beach': 'Palm Beach',
  'boynton beach': 'Palm Beach', 'lake worth': 'Palm Beach', 'lake worth beach': 'Palm Beach',
  'jupiter': 'Palm Beach', 'palm beach gardens': 'Palm Beach', 'royal palm beach': 'Palm Beach',
  'wellington': 'Palm Beach', 'greenacres': 'Palm Beach', 'riviera beach': 'Palm Beach',
  'belle glade': 'Palm Beach', 'pahokee': 'Palm Beach', 'palm beach': 'Palm Beach',
  'lantana': 'Palm Beach', 'loxahatchee': 'Palm Beach',
  'key west': 'Monroe', 'key largo': 'Monroe', 'marathon': 'Monroe',
  'islamorada': 'Monroe', 'tavernier': 'Monroe', 'big pine key': 'Monroe'
};

// ── Firecrawl Search ──────────────────────────────────────────────────────────

async function firecrawlSearch(query, limit = 5) {
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_KEY}`
      },
      body: JSON.stringify({ query, limit })
    });
    const json = await res.json();
    if (!json.success || !json.data) return [];
    return json.data.map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || ''
    }));
  } catch (err) {
    console.error(`[Firecrawl] Search failed: ${err.message}`);
    return [];
  }
}

// ── Jina Reader ───────────────────────────────────────────────────────────────

async function readPage(url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      method: 'GET',
      headers: { 'Accept': 'text/plain' },
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    if (text && text.length > 200) return text.slice(0, 40000);

    // Fallback to Firecrawl scrape
    const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_KEY}`
      },
      body: JSON.stringify({ url, formats: ['markdown'] })
    });
    const scrapeJson = await scrapeRes.json();
    return scrapeJson?.data?.markdown?.slice(0, 40000) || null;
  } catch (err) {
    console.error(`[Jina] Read failed for ${url}: ${err.message}`);
    return null;
  }
}

// ── Claude Extraction ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a healthcare industry article for construction, permit, and facility expansion activity in South Florida's Primary Service Area: Miami-Dade, Broward, Palm Beach, and Monroe counties.

Extract EVERY distinct construction project, facility filing, permit, groundbreaking, or expansion mentioned. Return a JSON array of objects.

For each project, return:
{
  "project_name": "descriptive name (e.g., '200-Bed Hospital', 'Deerfield Beach Freestanding Emergency Department')",
  "health_system": "who owns/operates it — match to a known system if possible",
  "county": "Miami-Dade | Broward | Palm Beach | Monroe",
  "address": "street address if mentioned, else null",
  "facility_type": "hospital | freestanding_ed | asc | mob | clinic | imaging_center | rehab | urgent_care | other",
  "estimated_value": "dollar figure if mentioned, else 'TBD'",
  "status": "application_filed | approved | under_construction | completed | unknown",
  "description": "1-2 sentence summary of the project scope",
  "evidence": "the exact quote(s) from the article supporting this extraction"
}

CRITICAL RULES:
1. ONLY extract projects physically in Miami-Dade, Broward, Palm Beach, or Monroe counties. Use city names to determine county.
2. BAPTIST HEALTH DISAMBIGUATION: "Baptist Health South Florida" (headquartered in Coral Gables) is OUR system. "Baptist Health" in Jacksonville or NE Florida is a DIFFERENT system. Disambiguate by geography. If the article says "Baptist Health" and the project is in our 4 counties, tag as "Baptist Health South Florida". If in Jacksonville/NE Florida, tag as "Baptist Health Jacksonville".
3. If an article mentions no relevant projects in our 4 counties, return an empty array: []
4. Do NOT extract national statistics, industry trends, or out-of-state projects.
5. If two paragraphs describe the same project, merge them into one entry.

KNOWN HEALTH SYSTEMS IN OUR MARKET (18 competitors + us):
1. Broward Health (also: North Broward Hospital District) — PUBLIC system, Broward County
2. CHS (Community Health Systems)
3. Cleveland Clinic Florida — Palm Beach expansion
4. HCA Florida (also: MD Now urgent care) — FOR-PROFIT, largest in FL
5. Holy Cross / Trinity Health — Broward
6. HSA (Health Systems of America)
7. Jackson Health (also: Jackson Memorial) — PUBLIC system, Miami-Dade
8. Jupiter Medical Center — Palm Beach County
9. Keralty — Miami-Dade
10. Lakeside / HCD Palm Beach County (Health Care District)
11. Larkin (Larkin Community Hospital) — Miami-Dade
12. Memorial Healthcare (also: Memorial Regional, Memorial Health) — PUBLIC system, Broward/South Dade. **MEMORIAL IS NOT HCA. THEY ARE SEPARATE SYSTEMS.**
13. Mount Sinai (Mount Sinai Medical Center) — Miami Beach + Aventura
14. Nicklaus Children's — Miami-Dade pediatric
15. Palm Beach Health / Tenet (also: USPI, Palms West, Good Samaritan, St. Mary's, Delray Medical Center)
16. UHealth / University of Miami (also: UM Health) — Miami-Dade academic
17. UHS / Universal Health Services (also: Wellington Regional) — Palm Beach
18. Baptist Health Jacksonville — **THIS IS NOT US.** Northeast Florida, completely separate system.
--- Baptist Health South Florida (BHSF) = **US.** Coral Gables HQ. Our projects go in the tracker too.

CRITICAL ATTRIBUTION RULES:
- Memorial Healthcare and HCA Florida are DIFFERENT competing systems. Never confuse them.
- Broward Health and Holy Cross are DIFFERENT systems, both in Broward County.
- Jackson Health is Miami-Dade's public system, NOT affiliated with HCA or any private chain.
- "Baptist Health" in our 4 counties = Baptist Health South Florida (us). In Jacksonville = different system.
- If you are unsure which system owns a project, set health_system to the exact name used in the article — do NOT guess.

CITY → COUNTY REFERENCE:
Miami-Dade: Miami, Hialeah, Homestead, Coral Gables, Doral, Aventura, Kendall, North Miami, Sunny Isles, Palmetto Bay, Pinecrest, Key Biscayne, South Miami, Cutler Bay
Broward: Fort Lauderdale, Hollywood, Pembroke Pines, Miramar, Coral Springs, Davie, Plantation, Sunrise, Pompano Beach, Deerfield Beach, Weston, Tamarac, Hallandale Beach, Parkland, Cooper City
Palm Beach: West Palm Beach, Boca Raton, Delray Beach, Boynton Beach, Jupiter, Palm Beach Gardens, Wellington, Royal Palm Beach, Lake Worth, Riviera Beach, Greenacres, Lantana
Monroe: Key West, Key Largo, Marathon, Islamorada

Return ONLY valid JSON. No markdown, no explanation, just the array.`;

async function extractPermits(articleContent, sourceUrl) {
  try {
    const response = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\nSource URL: ${sourceUrl}\n\nArticle content:\n${articleContent}`
      }]
    });

    const text = response.content[0]?.text?.trim();
    if (!text) return [];

    // Parse JSON — handle markdown code fences if model wraps it
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const permits = JSON.parse(jsonStr);
    return Array.isArray(permits) ? permits : [];
  } catch (err) {
    console.error(`[Extract] Failed for ${sourceUrl}: ${err.message}`);
    return [];
  }
}

// ── Permit ID Generation ──────────────────────────────────────────────────────

function generatePermitId(permit, sourceUrl) {
  const systemSlug = (permit.health_system || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const projectSlug = (permit.project_name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const countySlug = (permit.county || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${countySlug}-${systemSlug}-${projectSlug}`;
}

// ── Normalize System Name ─────────────────────────────────────────────────────

function normalizeSystem(rawName) {
  if (!rawName) return null;
  const lower = rawName.toLowerCase();
  for (const [canonical, aliases] of Object.entries(COMPETITOR_SYSTEMS)) {
    for (const alias of aliases) {
      if (lower.includes(alias.toLowerCase())) return canonical;
    }
  }
  return rawName; // Unknown system — keep raw name
}

// ── Fuzzy Dedup Check ─────────────────────────────────────────────────────────

function findExistingPermit(permit) {
  const permitId = generatePermitId(permit);
  const exact = getPermitById.get(permitId);
  if (exact) return exact;

  // Fuzzy: same system + county + similar project name
  if (permit.health_system && permit.county) {
    const candidates = db.prepare(
      `SELECT * FROM permits WHERE health_system = ? AND county = ? AND is_active = 1`
    ).all(permit.health_system, permit.county);

    const projectWords = new Set(
      (permit.project_name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    );
    for (const c of candidates) {
      const existingWords = new Set(
        (c.project_name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      );
      const overlap = [...projectWords].filter(w => existingWords.has(w) && w.length > 2).length;
      const minSize = Math.min(projectWords.size, existingWords.size);
      if (minSize > 0 && overlap / minSize >= 0.5) return c;
    }
  }
  return null;
}

// ── Upsert Pipeline ───────────────────────────────────────────────────────────

const VALID_COUNTIES = new Set(['Miami-Dade', 'Broward', 'Palm Beach', 'Monroe']);

function upsertPermit(permit, sourceUrl, sourceName) {
  // Reject if no health system identified
  if (!permit.health_system) {
    console.log(`    ⊘ Skipped (no health system): ${permit.project_name}`);
    return 'skipped';
  }
  // Reject if county is not in our PSA
  if (!VALID_COUNTIES.has(permit.county)) {
    console.log(`    ⊘ Skipped (not in PSA): ${permit.project_name} — ${permit.county}`);
    return 'skipped';
  }

  const system = normalizeSystem(permit.health_system);
  const permitId = generatePermitId({ ...permit, health_system: system });
  const existing = findExistingPermit({ ...permit, health_system: system });

  if (!existing) {
    // New permit
    try {
      insertPermit.run(
        permitId,
        permit.project_name,
        system,
        permit.county,
        permit.address || null,
        permit.facility_type || null,
        sourceName,
        sourceUrl,
        permit.estimated_value || 'TBD',
        permit.status || 'unknown',
        permit.description || null,
        permit.status !== 'unknown' ? new Date().toISOString().split('T')[0] : null,
        JSON.stringify({ evidence: permit.evidence, source_url: sourceUrl })
      );
      return 'new';
    } catch (err) {
      if (err.message.includes('UNIQUE constraint')) return 'duplicate';
      console.error(`[Upsert] Insert failed: ${err.message}`);
      return 'error';
    }
  }

  // Existing permit — check for changes
  let changed = false;
  const statusNorm = permit.status || 'unknown';
  const valueNorm = permit.estimated_value || 'TBD';

  if (statusNorm !== 'unknown' && statusNorm !== existing.status) {
    insertPermitHistory.run(existing.permit_id, 'status', existing.status, statusNorm, sourceName);
    changed = true;
  }
  if (valueNorm !== 'TBD' && valueNorm !== existing.estimated_value) {
    insertPermitHistory.run(existing.permit_id, 'estimated_value', existing.estimated_value, valueNorm, sourceName);
    changed = true;
  }

  if (changed) {
    updatePermit.run(
      statusNorm !== 'unknown' ? statusNorm : existing.status,
      valueNorm !== 'TBD' ? valueNorm : existing.estimated_value,
      permit.description || existing.description,
      new Date().toISOString().split('T')[0],
      existing.status,
      sourceUrl,
      JSON.stringify({ evidence: permit.evidence, source_url: sourceUrl }),
      existing.permit_id
    );
    return 'updated';
  }

  // No changes — just touch last_checked_date
  touchPermit.run(existing.permit_id);
  return 'unchanged';
}

// ── Search Queries ────────────────────────────────────────────────────────────

const NEWS_SEARCHES = [
  '"healthcare construction" OR "hospital construction" "South Florida" 2026',
  '"building permit" healthcare Florida "Miami-Dade" OR "Broward" OR "Palm Beach" 2026',
  'site:floridayimby.com healthcare OR hospital OR "medical center" OR "surgery center"',
  'site:rebusinessonline.com Florida healthcare construction',
  'site:southfloridahospitalnews.com construction OR permit OR "breaks ground" OR expansion',
  'site:beckershospitalreview.com Florida construction OR expansion OR "new hospital"',
];

const AHCA_SEARCHES = [
  'site:ahca.myflorida.com new facility application 2026',
  'site:ahca.myflorida.com hospital construction notification Florida 2026',
];

const NEWSROOM_SEARCHES = [
  '"Cleveland Clinic" OR "HCA Florida" OR "Broward Health" construction expansion Florida 2026',
  '"Memorial Healthcare" OR "Holy Cross" OR "Mount Sinai" OR "Jackson Health" construction Florida 2026',
  '"Nicklaus" OR "UHealth" OR "Jupiter Medical" OR "AdventHealth" construction Florida 2026',
  '"Tenet" OR "Larkin" OR "Keralty" OR "UHS" OR "Lakeside" construction healthcare Florida 2026',
  '"Baptist Health" construction expansion "South Florida" 2026',
];

// ── Main Scraper ──────────────────────────────────────────────────────────────

async function refreshPermits() {
  console.log('\n═══ Permit Tracker Refresh ═══');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const totals = { found: 0, new: 0, updated: 0, unchanged: 0, errors: 0 };
  const seenUrls = new Set();

  async function processSearchGroup(searches, sourceName) {
    const start = Date.now();
    let groupFound = 0, groupNew = 0, groupUpdated = 0;

    for (const query of searches) {
      console.log(`  [Search] ${query.slice(0, 80)}...`);
      const results = await firecrawlSearch(query, 5);
      console.log(`    → ${results.length} results`);

      for (const result of results) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);

        const content = await readPage(result.url);
        if (!content) {
          console.log(`    ✗ Could not read: ${result.url}`);
          continue;
        }

        const permits = await extractPermits(content, result.url);
        console.log(`    → ${permits.length} permits extracted from ${result.title?.slice(0, 60) || result.url}`);

        for (const permit of permits) {
          if (!permit.county || !permit.project_name) continue;
          groupFound++;
          const action = upsertPermit(permit, result.url, sourceName);
          if (action === 'new') groupNew++;
          else if (action === 'updated') groupUpdated++;
          else if (action === 'error') totals.errors++;
        }
      }
    }

    const duration = Date.now() - start;
    console.log(`  [${sourceName}] Done: ${groupFound} found, ${groupNew} new, ${groupUpdated} updated (${duration}ms)\n`);

    insertScraperRun.run(sourceName, 'success', groupFound, groupNew, groupUpdated, null, duration);
    totals.found += groupFound;
    totals.new += groupNew;
    totals.updated += groupUpdated;
  }

  try {
    // Layer 1: News discovery
    console.log('── Layer 1: News Discovery ──');
    await processSearchGroup(NEWS_SEARCHES, 'news');

    // Layer 2: AHCA
    console.log('── Layer 2: AHCA ──');
    await processSearchGroup(AHCA_SEARCHES, 'ahca');

    // Layer 3: Competitor newsrooms
    console.log('── Layer 3: Competitor Newsrooms ──');
    await processSearchGroup(NEWSROOM_SEARCHES, 'newsroom');

    // Mark stale permits
    const staleResult = markStalePermits.run();
    if (staleResult.changes > 0) {
      console.log(`\n⚠ Deactivated ${staleResult.changes} stale permits (not confirmed in 6+ weeks)`);
    }

    // Final summary
    const activeCount = db.prepare('SELECT COUNT(*) as n FROM permits WHERE is_active=1').get().n;
    console.log('\n═══ Summary ═══');
    console.log(`Found: ${totals.found} | New: ${totals.new} | Updated: ${totals.updated} | Errors: ${totals.errors}`);
    console.log(`Total active permits in database: ${activeCount}`);
    console.log(`Finished: ${new Date().toISOString()}\n`);

    return {
      status: 'success',
      found: totals.found,
      new: totals.new,
      updated: totals.updated,
      errors: totals.errors,
      total_active: activeCount
    };
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    insertScraperRun.run('fatal', 'failed', 0, 0, 0, err.message, 0);
    return { status: 'error', message: err.message };
  }
}

// Run directly or export for endpoint
if (require.main === module) {
  refreshPermits().then(result => {
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}

module.exports = { refreshPermits };
