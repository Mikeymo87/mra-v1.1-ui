// ── Structured Market Data Endpoint (G1) ────────────────────────────────────
// Deterministic JSON market-data pull for the Marketing Planner. NO conversational
// LLM in the hot path — every field is a direct, cacheable tool pull. Reuses the
// MRA's existing tool executors (executeTool) and local data sets so there is a
// single source of truth shared with /api/chat.
//
// POST /api/market-data
//   { zips?: string[], address?: string, radius?: number|number[],
//     service_lines?: string[], include?: string[], session_id?: string }
// → deterministic JSON (see buildResponse JSDoc / scope doc).

const crypto = require('crypto');

// Census variable → human field map (subset we surface; mirrors CENSUS_VAR_MAP).
const CENSUS_FIELD_MAP = {
  DP05_0001E: 'total_pop',
  DP05_0018E: 'median_age',
  DP05_0024PE: 'age_65_plus_pct',
  DP03_0062E: 'median_hhi',
  // Payer mix (all-ages percentages, clean from Data Profile)
  DP03_0096PE: 'insured_pct',
  DP03_0097PE: 'commercial_pct',     // private/commercial (all ages)
  DP03_0098PE: 'public_pct',         // public coverage (all ages)
  DP03_0099PE: 'uninsured_pct',
  // 19-64 counts — server derives commercial_18_64_pct from these (the DP03 "PE"
  // sub-rows are nested ratios, NOT % of the 19-64 population, so we use counts).
  DP03_0102E: '_pop_19_64',            // total civilian noninst. pop 19-64
  DP03_0106E: '_priv_emp_19_64',       // employed 19-64 with private insurance
  DP03_0111E: '_priv_unemp_19_64',     // unemployed 19-64 with private insurance
  DP03_0107E: '_pub_emp_19_64',        // employed 19-64 with public coverage
};

// Age-band Data-Profile variables (count + pct) → labelled bands.
const AGE_BAND_MAP = {
  DP05_0005: 'under_5',  DP05_0006: '5_9',   DP05_0007: '10_14', DP05_0008: '15_19',
  DP05_0009: '20_24',    DP05_0010: '25_34', DP05_0011: '35_44', DP05_0012: '45_54',
  DP05_0013: '55_59',    DP05_0014: '60_64', DP05_0015: '65_74', DP05_0016: '75_84',
};

// CDC PLACES measures that carry orthopedic / chronic-care demand signal. We pass
// through ALL measures but surface these as a flat demand block for convenience.
const DEMAND_MEASURES = [
  'ARTHRITIS', 'OBESITY', 'LPA', 'CHECKUP', 'PHLTH', 'MOBILITY',
  'DIABETES', 'BPHIGH', 'HIGHCHOL', 'DEPRESSION', 'ACCESS2', 'GHLTH',
];

// Static field-glossary block returned with every response so downstream
// consumers (the planner, humans) never misread a denominator. Purely additive.
const FIELD_DEFINITIONS = {
  payer_mix: {
    commercial_pct: 'Private/commercial coverage as % of the civilian noninstitutionalized population, ALL AGES (ACS DP03_0097PE).',
    public_pct: 'Public coverage (Medicare/Medicaid/VA) as % of the civilian noninstitutionalized population, ALL AGES (ACS DP03_0098PE).',
    uninsured_pct: 'Uninsured as % of the civilian noninstitutionalized population, ALL AGES (ACS DP03_0099PE).',
    commercial_18_64_pct: 'Share of the 19-64 civilian noninstitutionalized population with private coverage (derived from ACS counts DP03_0106E + DP03_0111E over DP03_0102E) - the commercially insured working-age cohort BH marketing targets. Different denominator than commercial_pct; NOT comparable.',
    public_18_64_pct: 'Employed 19-64 population with public coverage (ACS DP03_0107E) as a share of the total 19-64 population (DP03_0102E), same 19-64 denominator.',
  },
  health_behaviors: 'CDC PLACES model-based estimates (BRFSS), % of adults per ZIP.',
  competitors: 'Google Places search per service line, 30-mile cap. With an address the pull is ANCHORED (nearest-first Nearby Search); without one it falls back to a city-level prominence text search - check pull_quality.competitors.method. Use competitors_tiered_by_line for per-service-line drive-time tiers.',
  competitors_tiered_by_line: 'One tiered competitor set PER service line, each with category-appropriate drive-time caps (convenience categories cap tighter and demote 20+ min results to broader_context_summary - context, never table rows). For a multi-service-line facility, present one table per line from this field.',
  own_network: 'Baptist Health\'s OWN nearby facilities from the full Yext cache (never competitors). overlapping_service_lines non-empty = a same-service BH site is nearby: weigh network synergy AND cannibalization; the plan must acknowledge these sites.',
  pull_quality: 'How each pull actually ran (search method, anchor, result counts, trims, data_logic_version). An unanchored method or tiny result counts for an address-anchored plan means the pull is weak - re-pull with the address rather than writing around it.',
  trade_area: 'Drive-time isochrone catchment; population from CDC PLACES ZIP populations.',
};

// Map a planner service-line label to a Yext physician specialty keyword.
function serviceLineToSpecialty(label, SPECIALTY_SYNONYMS) {
  const l = (label || '').toLowerCase().trim();
  if (SPECIALTY_SYNONYMS[l]) return SPECIALTY_SYNONYMS[l];
  for (const [k, v] of Object.entries(SPECIALTY_SYNONYMS)) {
    if (l.includes(k) || k.includes(l)) return v;
  }
  // Common planner phrasings not in the synonym map.
  if (/ortho|sports med|joint|spine/.test(l)) return 'Orthop';
  if (/cardio|heart|vascular/.test(l)) return 'Cardio';
  if (/neuro|brain/.test(l)) return 'Neuro';
  if (/cancer|oncol/.test(l)) return 'Oncol';
  if (/primary|family|internal/.test(l)) return ['Internal Medicine', 'Family Medicine'];
  if (/urgent|same.?day/.test(l)) return null; // no physician roster for urgent care
  return null;
}

// Map a planner service-line label to a Google Places search term.
function serviceLineToSearchTerm(label) {
  const l = (label || '').toLowerCase().trim();
  if (/ortho|sports med|joint|spine/.test(l)) return 'orthopedic';
  if (/cardio|heart|vascular/.test(l)) return 'cardiology';
  if (/neuro|brain/.test(l)) return 'neurology';
  if (/cancer|oncol/.test(l)) return 'cancer center';
  if (/primary|family|internal/.test(l)) return 'primary care';
  if (/urgent|same.?day|walk/.test(l)) return 'urgent care';
  if (/imaging|radiology|mri/.test(l)) return 'imaging center';
  if (/surgery|surgical/.test(l)) return 'surgery center';
  return l || 'healthcare';
}

// Bump when the market-data logic changes in a way that should invalidate
// cached responses (also surfaced in pull_quality so consumers can gate on it).
const DATA_LOGIC_VERSION = 'md-2026-07-09';

// Per-category drive-time tolerance for the tier tables. Convenience
// categories are chosen on proximity - a 20+ minute "competitor" is context,
// not a table row. Destination/specialty categories keep the wider default.
function categoryCapsFor(term) {
  const t = (term || '').toLowerCase();
  if (t === 'urgent care') return { inMarketMax: 8, adjacentMax: 12, dropBroader: true };
  if (t === 'imaging center') return { inMarketMax: 10, adjacentMax: 15, dropBroader: true };
  if (t === 'primary care') return { inMarketMax: 10, adjacentMax: 15, dropBroader: true };
  return { inMarketMax: 10, adjacentMax: 20, dropBroader: false };
}

// Map a planner service-line label to a Yext facility-name matcher, so
// own_network can say WHICH nearby BH sites overlap the requested service.
// Keyword vocabulary per the verified Yext list in CLAUDE.md.
function serviceLineToYextRe(label) {
  const l = (label || '').toLowerCase().trim();
  if (/urgent|same.?day|walk/.test(l)) return /urgent care|same.?day|express/i;
  if (/imaging|radiology|mri/.test(l)) return /imaging|diagnostic/i;
  if (/ortho|sports med|joint|spine/.test(l)) return /orthop|spine|sports/i;
  if (/cardio|heart|vascular/.test(l)) return /cardio|vascular|heart/i;
  if (/neuro|brain/.test(l)) return /neuro/i;
  if (/cancer|oncol/.test(l)) return /cancer|oncolog/i;
  if (/primary|family|internal/.test(l)) return /primary care/i;
  if (/surgery|surgical/.test(l)) return /surgery|surgical|endoscopy/i;
  if (/emergency|\ber\b/.test(l)) return /emergency/i;
  return null;
}

// Care-type label for a BH facility name (coarse; used for display/grouping).
function bhCareType(name) {
  const n = name || '';
  if (/urgent|same.?day|express/i.test(n)) return 'urgent';
  if (/imaging|diagnostic/i.test(n)) return 'imaging';
  if (/emergency/i.test(n)) return 'emergency';
  if (/hospital/i.test(n)) return 'hospital';
  if (/primary care/i.test(n)) return 'primary care';
  return 'specialty';
}

// Baptist Health South Florida owned brands. A competitor text search surfaces
// BH's OWN facilities (and several BH brands that don't carry the word
// "Baptist" - Miami Cancer Institute, Boca Raton Regional, Bethesda, etc.).
// These must never be returned as competitors; we route them to own_network
// instead so the planner can still see BH's existing footprint.
const BH_OWNED_RE = new RegExp([
  'baptist health', 'baptist hospital', 'baptist outpatient', 'baptist emergency',
  'baptist medical', 'baptist surgery', '\\bbaptist\\b',
  'south miami hospital', 'doctors hospital', 'west kendall baptist',
  'homestead hospital', 'mariners hospital', "fishermen'?s community",
  'bethesda hospital', 'boca raton regional', 'lynn cancer institute',
  'miami cancer institute', 'miami neuroscience institute',
  'miami cardiac', 'miami orthopedics', 'marcus neuroscience',
  'christine e\\.? lynn', 'eugene m\\.? & christine',
].join('|'), 'i');

function isBhOwned(name) {
  return BH_OWNED_RE.test(name || '');
}

// Turn a read_page markdown dump into a clean plain-text excerpt for a news item.
function newsExcerpt(md, max = 600) {
  if (!md) return null;
  let s = String(md);
  // Jina Reader prepends "Title: ... URL Source: ... Published Time: ... Markdown
  // Content:" - cut to the actual article body when that header is present.
  const mc = s.search(/Markdown Content:/i);
  if (mc !== -1) s = s.slice(mc + 'Markdown Content:'.length);
  s = s.replace(/^\s*(Title:|URL Source:|Published Time:)[^\n]*\n?/gim, '');
  const t = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links -> link text
    .replace(/^[#>\-\*\s]+/gm, '')              // leading heading/list markers
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, max) : null;
}

// Yext filter (URL-encoded) for physicians by specialty + city.
function buildPhysicianFilter(specialty, city) {
  const obj = {
    c_listOfSpecialties: { $contains: specialty },
    closed: { $eq: false },
  };
  if (city) obj['address.city'] = { $eq: city };
  return encodeURIComponent(JSON.stringify(obj));
}

// Parse a Census Data-Profile envelope ([_rawData] = [[headers],[row]...]) into
// a per-ZIP object keyed by ZIP, merging successive calls.
function mergeCensusRows(into, rawData, fieldMap, ageBands) {
  if (!Array.isArray(rawData) || rawData.length < 2) return;
  const headers = rawData[0];
  const zipIdx = headers.indexOf('zip code tabulation area');
  if (zipIdx === -1) return;
  for (let r = 1; r < rawData.length; r++) {
    const row = rawData[r];
    const zip = row[zipIdx];
    if (!zip) continue;
    if (!into[zip]) into[zip] = { zip, age_bands: {} };
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      const num = parseFloat(row[c]);
      // Scalar fields
      if (fieldMap[h] != null && !isNaN(num)) into[zip][fieldMap[h]] = num;
      // Age bands (only when requested)
      if (ageBands) {
        const base = h.replace(/E$|PE$/, '');
        if (AGE_BAND_MAP[base] && !isNaN(num)) {
          const band = AGE_BAND_MAP[base];
          if (!into[zip].age_bands[band]) into[zip].age_bands[band] = {};
          if (/PE$/.test(h)) into[zip].age_bands[band].pct = num;
          else into[zip].age_bands[band].count = num;
        }
      }
    }
  }
}

// Build a per-ZIP CDC demand block from the cdc_health_behaviors envelope.
function buildHealthBehaviors(rawData) {
  const out = [];
  for (const [zip, entry] of Object.entries(rawData || {})) {
    if (entry?.error || !entry?.measures) continue;
    const row = { zip, population: entry.population || null };
    for (const m of DEMAND_MEASURES) {
      const v = entry.measures[m]?.value;
      if (v != null) row[m.toLowerCase()] = v;
    }
    out.push(row);
  }
  return out;
}

// Centroid for a ZIP from the ZCTA geojson (used to seed an origin from zips).
function zipCentroid(zctaGeoJSON, zip) {
  if (!zctaGeoJSON) return null;
  const f = zctaGeoJSON.features.find(f => f.properties.ZCTA5CE20 === zip);
  if (!f) return null;
  const coords = f.geometry.type === 'Polygon'
    ? f.geometry.coordinates[0]
    : f.geometry.coordinates[0][0];
  const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return { lat, lng };
}

// Catchment ZIPs from an isochrone (centroid-in-polygon), reusing the server's
// pointInIsochrone helper.
function catchmentFromIsochrone(zctaGeoJSON, isochrone, pointInIsochrone, cdcPlacesData) {
  if (!zctaGeoJSON || !isochrone?.features) return { zips: [], population: 0 };
  const zips = [];
  let population = 0;
  for (const f of zctaGeoJSON.features) {
    const zip = f.properties.ZCTA5CE20;
    const coords = f.geometry.type === 'Polygon'
      ? f.geometry.coordinates[0]
      : f.geometry.coordinates[0][0];
    const cLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    if (pointInIsochrone(cLat, cLng, isochrone)) {
      zips.push(zip);
      const pop = cdcPlacesData?.[zip]?.population;
      if (pop) population += Number(pop) || 0;
    }
  }
  return { zips, population };
}

// Normalize radius into an array of minutes.
function normalizeRadius(radius) {
  if (Array.isArray(radius) && radius.length) return radius.filter(n => Number(n) > 0).map(Number);
  const n = Number(radius);
  if (n > 0) return [n];
  return [10, 15, 20];
}

// Dedupe + sort the caller's ZIP list once so the same ZIP SET always produces
// the same origin and response regardless of input order. (The cache key already
// sorted zips, so different orderings aliased to one cache entry while producing
// different origins - this makes the build itself order-independent.)
function normalizeZips(zipsInput) {
  return [...new Set(
    (zipsInput || [])
      .filter(z => z != null) // String(null) would survive filter(Boolean) as 'null'
      .map(z => String(z).trim())
      .filter(Boolean)
  )].sort();
}

// executeTool NEVER throws - failures come back as envelope objects with
// status:'failed' and { error } payloads. Surface that as a string (or null on
// success) so each block can treat a failed envelope as a block failure.
function envelopeError(env) {
  if (!env || typeof env !== 'object') return 'no result returned';
  const raw = env._rawData !== undefined ? env._rawData : env.data;
  if (env.status === 'failed') {
    return (raw && typeof raw === 'object' && raw.error) ? String(raw.error) : 'tool call failed';
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.error) return String(raw.error);
  return null;
}

// ── Competitor tiering (drive-time market tiers) ────────────────────────────
// Google Places text search returns a flat, strength-sorted list. The planner
// needs to know which competitors are IN the trade area vs adjacent submarkets
// vs broader-region noise, and which "competitors" are actually individual
// practitioners rather than destination facilities.

const FACILITY_WORDS = /\b(center|centre|clinic|institute|hospital|orthopedic?s?|orthopaedic?s?|medical|health|care|group|associates|partners|specialists|sports|physical therapy|rehab|urgent|imaging|mri|surgery|surgical|spine|joint|wellness|network|physicians)\b/i;
const CRED_RE = /,?\s+(m\.?d\.?|d\.?o\.?|d\.?p\.?m\.?|p\.?a\.?|a\.?r\.?n\.?p\.?|dpt|pa-c)\.?\s*$/i;

// Heuristic: does this Places result look like a person, not a facility?
// True on a credential suffix ("..., MD"), a "Dr. " prefix without facility
// words, or a bare 2-3 capitalized-token person-name shape without facility words.
function isIndividualPractitioner(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (CRED_RE.test(n)) return true;
  if (FACILITY_WORDS.test(n)) return false;
  if (/^dr\.?\s+/i.test(n)) return true;
  const tokens = n.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 3 &&
      tokens.every(t => /^[A-Z][a-z'.’-]+$/.test(t))) {
    return true;
  }
  return false;
}

// City parsed from a Google formatted_address: the segment immediately before
// the state segment ("..., Doral, FL 33172, USA" → "Doral").
function submarketFromAddress(address) {
  if (!address) return null;
  const parts = String(address).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  for (let i = parts.length - 1; i > 0; i--) {
    if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(parts[i])) return parts[i - 1] || null;
  }
  // Fallback: 2nd-from-last segment (skipping a trailing country segment).
  const idx = /^(usa|united states)$/i.test(parts[parts.length - 1])
    ? parts.length - 3 : parts.length - 2;
  return parts[idx] || null;
}

/**
 * Tier competitors by drive time from the origin.
 * - Only competitors with drive_time_min != null participate.
 * - Individual practitioners are split out (flagged, never dropped).
 * - Destination facilities are sorted by drive time; IN-MARKET = within
 *   inMarketMax minutes AND before the first drive-time jump where
 *   next > prev*gapRatio and (next - prev) >= gapMinAbs.
 * - ADJACENT = the rest within adjacentMax minutes, labeled with a submarket
 *   (city) parsed from the address. BROADER = beyond adjacentMax.
 * - Within each tier, entries are ranked by rating x reviews (rating orders
 *   WITHIN a tier only - it never promotes a far facility into the market).
 * - nearest_comparable = the closest destination, with a note, when in_market
 *   is empty (thin-market floor so the planner always has a benchmark).
 * Returns null when no competitor has a drive time.
 */
function tierCompetitors(competitors, { inMarketMax = 10, adjacentMax = 20, gapRatio = 1.5, gapMinAbs = 3 } = {}) {
  const withDt = (competitors || []).filter(c => c && c.drive_time_min != null);
  if (!withDt.length) return null;

  const individuals = [];
  const destinations = [];
  for (const c of withDt) {
    if (isIndividualPractitioner(c.name)) individuals.push({ ...c, individual_practitioner: true });
    else destinations.push({ ...c });
  }
  destinations.sort((a, b) => a.drive_time_min - b.drive_time_min);

  // In-market cut: stop at the first destination past inMarketMax, or at the
  // first significant drive-time jump (both ratio AND absolute-minutes gates).
  let cut = 0;
  for (let i = 0; i < destinations.length; i++) {
    const dt = destinations[i].drive_time_min;
    if (dt > inMarketMax) break;
    if (i > 0) {
      const prev = destinations[i - 1].drive_time_min;
      if (dt > prev * gapRatio && (dt - prev) >= gapMinAbs) break;
    }
    cut = i + 1;
  }

  const inMarket = destinations.slice(0, cut);
  const rest = destinations.slice(cut);
  const adjacent = rest.filter(d => d.drive_time_min <= adjacentMax)
    .map(d => ({ ...d, submarket: submarketFromAddress(d.address) }));
  const broader = rest.filter(d => d.drive_time_min > adjacentMax);

  const byStrength = (a, b) => (b.rating || 0) * (b.reviews || 0) - (a.rating || 0) * (a.reviews || 0);
  inMarket.sort(byStrength);
  adjacent.sort(byStrength);
  broader.sort(byStrength);
  individuals.sort(byStrength);

  let nearestComparable = null;
  if (!inMarket.length && destinations.length) {
    nearestComparable = {
      ...destinations[0],
      note: `No destination competitor within the in-market window; nearest comparable facility is ${destinations[0].drive_time_min} min away (thin-market floor).`,
    };
  }

  return {
    in_market: inMarket,
    adjacent,
    broader,
    individual_practitioners: individuals,
    nearest_comparable: nearestComparable,
    method: `Destination facilities sorted by drive time from origin. IN-MARKET = <=${inMarketMax} min and before the first drive-time jump (next > ${gapRatio}x prev AND gap >= ${gapMinAbs} min). ADJACENT = remaining <=${adjacentMax} min, labeled by submarket city. BROADER = >${adjacentMax} min. Individual practitioners are split out, never dropped. Within each tier, entries rank by rating x reviews; rating never promotes a distant facility into the market. Caveat: results reflect Google Places visibility (address-anchored pulls keep the ~15 NEAREST per service-line term; unanchored pulls keep the top 10 by rating x reviews), so tiers are the nearest known visible competitors, not an exhaustive census.`,
  };
}

/**
 * Build the deterministic market-data response.
 * Blocks run CONCURRENTLY (respecting the dependency graph) with per-block
 * isolation: a failed block becomes a warning + fallback value, never a failed
 * request. Response shape is byte-compatible with the serial version except
 * for additive fields (competitors_tiered, field_definitions,
 * evidence_coverage.blocks_failed).
 * @param body request body
 * @param deps server internals injected from server.js
 */
async function buildMarketData(body, deps) {
  const {
    executeTool, cdcPlacesData, zctaGeoJSON, pointInIsochrone,
    SPECIALTY_SYNONYMS, demographicIndex,
  } = deps;

  const zips = normalizeZips(body.zips);
  const address = body.address ? String(body.address).trim() : null;
  const serviceLines = Array.isArray(body.service_lines) ? body.service_lines.filter(Boolean) : [];
  const radiusMinutes = normalizeRadius(body.radius || body.radius_minutes);

  const DEFAULT_INCLUDE = [
    'demographics', 'payer_mix', 'health_behaviors',
    'competitors', 'drive_times', 'trade_area',
  ];
  const include = new Set(
    Array.isArray(body.include) && body.include.length ? body.include : DEFAULT_INCLUDE
  );
  // payer_mix rides on the demographics census pull
  if (include.has('payer_mix')) include.add('demographics');

  // ── Stage 0: resolve origin (one geocode, or local ZIP centroids) ────────
  const originWarnings = [];
  const originSources = new Set();
  let origin = null;
  if (address) {
    const ctx0 = { originCoords: null };
    const enc = encodeURIComponent(address).replace(/%20/g, '+');
    const geo = await executeTool('geocode_address', { address: enc }, null, ctx0);
    originSources.add('Google Geocoding API');
    const geoErr = envelopeError(geo);
    if (geoErr) originWarnings.push(`origin geocode failed: ${geoErr}`);
    const r = (geo._rawData || geo.data);
    const loc = Array.isArray(r) ? r[0]?.geometry?.location : r?.geometry?.location;
    if (loc) origin = { lat: loc.lat, lng: loc.lng, label: (Array.isArray(r) ? r[0]?.formatted_address : null) || address };
    if ((geo.warnings || []).length) originWarnings.push(...geo.warnings.map(w => (typeof w === 'string' ? w : w.message)));
  }
  if (!origin && zips.length) {
    // Deterministic origin: the AVERAGE of all provided ZIP centroids, not just
    // zips[0] (which made the origin depend on caller ordering while the cache
    // key did not). Falls back to the single found centroid when only one
    // resolves.
    const found = zips.map(z => ({ zip: z, c: zipCentroid(zctaGeoJSON, z) })).filter(x => x.c);
    if (found.length > 1) {
      const lat = found.reduce((s, x) => s + x.c.lat, 0) / found.length;
      const lng = found.reduce((s, x) => s + x.c.lng, 0) / found.length;
      origin = { lat, lng, label: `centroid of ${found.length} trade-area ZIPs` };
    } else if (found.length === 1) {
      origin = { lat: found[0].c.lat, lng: found[0].c.lng, label: `ZIP ${found[0].zip} centroid` };
    }
  }

  // Tool executors MUTATE the shared ctx (geocode_address and
  // drive_time_isochrone set ctx.originCoords). Under parallelism each block
  // gets its own clone so no block can clobber another's origin.
  const blockCtx = () => ({ originCoords: origin ? { lat: origin.lat, lng: origin.lng } : null });

  // Per-block isolation runner. fn receives a tracker t = { warnings, sources }
  // scoped to the block; warnings/sources are merged in a stable order at the
  // end so responses stay deterministic under concurrency.
  async function runBlock(name, fn, fallback) {
    const t = { warnings: [], sources: new Set() };
    try {
      const value = await fn(t);
      return { name, value, warnings: t.warnings, sources: t.sources, failed: false };
    } catch (e) {
      t.warnings.push(`${name} failed: ${e.message}`);
      return { name, value: fallback, warnings: t.warnings, sources: t.sources, failed: true };
    }
  }

  // ── Trade area (isochrone → catchment ZIPs) ─────────────────────────────
  const tradeAreaP = runBlock('trade_area', async (t) => {
    if (!include.has('trade_area') || !origin) return null;
    const rangeSeconds = radiusMinutes.slice(0, 3).map(m => m * 60);
    const iso = await executeTool('drive_time_isochrone',
      { lat: origin.lat, lng: origin.lng, range: rangeSeconds }, null, blockCtx());
    t.sources.add('OpenRouteService Isochrone API');
    const err = envelopeError(iso);
    if (err) throw new Error(err);
    const isoData = iso._rawData || iso.data;
    if (!isoData?.features) {
      t.warnings.push('Trade-area isochrone unavailable; catchment not computed.');
      return null;
    }
    const { zips: catchmentZips, population } =
      catchmentFromIsochrone(zctaGeoJSON, isoData, pointInIsochrone, cdcPlacesData);
    return {
      origin,
      minutes: radiusMinutes,
      catchment_zips: catchmentZips,
      catchment_population: population,
    };
  }, null);

  // Effective ZIPs: caller-provided, else derived from the trade-area catchment
  // (limited to ZIPs with CDC coverage to keep Census calls bounded). Address-
  // only demographics/CDC pulls therefore chain off the trade-area promise.
  const zipsP = zips.length
    ? Promise.resolve(zips)
    : tradeAreaP.then(r => ((r.value && r.value.catchment_zips) || [])
        .filter(z => cdcPlacesData?.[z]).slice(0, 40));

  // ── Demographics + payer mix (deterministic Census pulls) ────────────────
  const demographicsP = runBlock('demographics', async (t) => {
    const effectiveZips = await zipsP;
    const demoByZip = {};
    if (!include.has('demographics') || !effectiveZips.length) return demoByZip;
    const zipList = effectiveZips.join(',');
    // Call A: population, age bands, median age, 65+.
    const ageVars = ['DP05_0001E', 'DP05_0018E', 'DP05_0024PE',
      'DP05_0005E', 'DP05_0005PE', 'DP05_0006E', 'DP05_0006PE', 'DP05_0007E', 'DP05_0007PE',
      'DP05_0008E', 'DP05_0008PE', 'DP05_0009E', 'DP05_0009PE', 'DP05_0010E', 'DP05_0010PE',
      'DP05_0011E', 'DP05_0011PE', 'DP05_0012E', 'DP05_0012PE', 'DP05_0013E', 'DP05_0013PE',
      'DP05_0014E', 'DP05_0014PE', 'DP05_0015E', 'DP05_0015PE', 'DP05_0016E', 'DP05_0016PE'];
    // Call B: income + payer mix (all-ages % + 19-64 counts for commercial cohort).
    const payVars = ['DP03_0062E', 'DP03_0096PE', 'DP03_0097PE', 'DP03_0098PE',
      'DP03_0099PE', 'DP03_0102E', 'DP03_0106E', 'DP03_0111E', 'DP03_0107E'];
    // The two Census calls are independent — run them concurrently.
    const [callA, callB] = await Promise.all([
      executeTool('census_demographics_lookup', {
        year: '2024',
        endpoint: `/profile?get=NAME,${ageVars.join(',')}&for=zip+code+tabulation+area:${zipList}`,
      }, null, blockCtx()),
      executeTool('census_demographics_lookup', {
        year: '2024',
        endpoint: `/profile?get=NAME,${payVars.join(',')}&for=zip+code+tabulation+area:${zipList}`,
      }, null, blockCtx()),
    ]);
    t.sources.add(callA._source?.api || 'Census ACS 5-Year');
    const errA = envelopeError(callA);
    const errB = envelopeError(callB);
    if (errA && errB) throw new Error(errA);
    if (errA) t.warnings.push(`demographics age/population pull failed: ${errA}`);
    else {
      mergeCensusRows(demoByZip, callA._rawData || callA.data, CENSUS_FIELD_MAP, true);
      if ((callA.warnings || []).length) t.warnings.push(...callA.warnings.map(w => (typeof w === 'string' ? w : w.message)));
    }
    if (errB) t.warnings.push(`demographics income/payer pull failed: ${errB}`);
    else {
      mergeCensusRows(demoByZip, callB._rawData || callB.data, CENSUS_FIELD_MAP, false);
      if ((callB.warnings || []).length) t.warnings.push(...callB.warnings.map(w => (typeof w === 'string' ? w : w.message)));
    }

    // Derive 19-64 commercial/public % from clean counts (% of 19-64 population).
    for (const zip of Object.keys(demoByZip)) {
      const d = demoByZip[zip];
      const pop = d._pop_19_64;
      if (pop && pop > 0) {
        const priv = (d._priv_emp_19_64 || 0) + (d._priv_unemp_19_64 || 0);
        d.commercial_18_64_pct = round((priv / pop) * 100, 1);
        if (d._pub_emp_19_64 != null) d.public_18_64_pct = round((d._pub_emp_19_64 / pop) * 100, 1);
      }
      delete d._pop_19_64; delete d._priv_emp_19_64; delete d._priv_unemp_19_64; delete d._pub_emp_19_64;
    }
    return demoByZip;
  }, {});

  // ── Health behaviors (CDC PLACES — local JSON, effectively instant) ──────
  const healthBehaviorsP = runBlock('health_behaviors', async (t) => {
    const effectiveZips = await zipsP;
    if (!include.has('health_behaviors') || !effectiveZips.length) return [];
    const cdc = await executeTool('cdc_health_behaviors',
      { zip_codes: effectiveZips.join(',') }, null, blockCtx());
    t.sources.add('CDC PLACES (BRFSS)');
    const err = envelopeError(cdc);
    if (err) throw new Error(err);
    if ((cdc.warnings || []).length) t.warnings.push(...cdc.warnings.map(w => (typeof w === 'string' ? w : w.message)));
    return buildHealthBehaviors(cdc._rawData || cdc.data);
  }, []);

  // ── Competitors + drive times (per service line, deduped) ────────────────
  const COMPETITOR_MAX_MILES = 30; // drop statewide noise; keep the real market
  const competitorsP = runBlock('competitors', async (t) => {
    const out = { competitors: [], ownNetwork: [] };
    if (!include.has('competitors')) return out;
    // Anchor the Places query to a city near the origin. Prefer an explicit city
    // from the address; otherwise reverse-geocode the origin to a locality.
    let cityHint = (address && address.split(',')[1]) ? address.split(',')[1].trim() : null;
    if (!cityHint && origin) {
      const rev = await executeTool('geocode_address',
        { address: encodeURIComponent(`${origin.lat},${origin.lng}`) }, null, blockCtx());
      const rr = rev._rawData || rev.data;
      const comps = Array.isArray(rr) ? rr[0]?.address_components : rr?.address_components;
      cityHint = comps?.find(c => c.types?.includes('locality'))?.long_name || null;
    }
    cityHint = cityHint || 'Miami';
    const terms = serviceLines.length
      ? serviceLines.map(serviceLineToSearchTerm)
      : ['hospital'];
    // All per-service-line searches in parallel; results folded back in
    // term order so dedupe stays deterministic. With an origin the search is
    // ANCHORED (Nearby Search, nearest-first) - the fix for the July 9 recall
    // failure where a metro-level text search returned famous-but-far results
    // and missed the MD Now across the street.
    const searches = await Promise.all(terms.map(async (term) => {
      const q = encodeURIComponent(`${term} near ${cityHint} FL`).replace(/%20/g, '+');
      const params = origin
        ? { query: q, location: `${origin.lat},${origin.lng}` }
        : { query: q };
      const comp = await executeTool('competitor_ratings_reviews', params, null, blockCtx());
      t.sources.add(origin ? 'Google Places Nearby Search (distance-ranked)' : 'Google Places Text Search');
      return { term, comp };
    }));
    const seen = new Map();
    let searchFailures = 0;
    out.pullQuality = {
      method: origin ? 'anchored-nearby-search (rankby=distance)' : 'city-level-text-search (prominence-ranked)',
      origin_used: origin ? { lat: origin.lat, lng: origin.lng } : null,
      per_term: {},
    };
    for (const { term, comp } of searches) {
      const err = envelopeError(comp);
      if (err) {
        searchFailures++;
        t.warnings.push(`competitor search "${term}" failed: ${err}`);
        out.pullQuality.per_term[term] = { failed: true };
        continue;
      }
      const places = comp._rawData || comp.data || [];
      out.pullQuality.per_term[term] = {
        results_returned: Array.isArray(places) ? places.length : 0,
        trim: comp.filtering || null,
      };
      for (const p of (Array.isArray(places) ? places : [])) {
        const key = p.place_id || p.name;
        if (!key) continue;
        if (seen.has(key)) {
          // Same facility matched another service-line search - keep ALL tags
          // so per-line tiering can place it in every relevant table.
          const row = seen.get(key);
          if (!row.service_lines.includes(term)) row.service_lines.push(term);
          continue;
        }
        const lat = p.geometry?.location?.lat;
        const lng = p.geometry?.location?.lng;
        let distance_mi = null;
        if (origin && lat && lng) distance_mi = round(deps.haversineDistance(origin.lat, origin.lng, lat, lng), 1);
        // Drop out-of-market results (statewide chains the text search can surface).
        if (origin && distance_mi != null && distance_mi > COMPETITOR_MAX_MILES) continue;
        seen.set(key, {
          name: p.name,
          rating: p.rating ?? null,
          reviews: p.user_ratings_total ?? null,
          address: p.formatted_address || '',
          place_id: p.place_id || null,
          lat: lat ?? null,
          lng: lng ?? null,
          service_line: term,           // first matching term (legacy field)
          service_lines: [term],        // ALL matching terms (additive)
          distance_mi,
          drive_time_min: null,
        });
      }
    }
    if (searchFailures === searches.length && searches.length) {
      throw new Error(`all ${searches.length} competitor searches failed`);
    }
    // Split BH-owned facilities out of the competitor set. They are not
    // competitors; surface them separately so the planner knows BH's footprint
    // and never writes "our competitor is Baptist Health ...".
    const placesOwn = [];
    for (const c of seen.values()) {
      if (isBhOwned(c.name)) placesOwn.push({ ...c, own: true });
      else out.competitors.push(c);
    }

    // own_network comes from the FULL Yext facility cache, not from whatever
    // Google Places happened to rank in a competitor search (that name-regex
    // shortcut silently missed BH Diagnostic Imaging Brickell + Coral Gables
    // on July 9). Places-derived BH hits are merged in only to supply
    // rating/review counts for sites Yext already confirms.
    const OWN_NETWORK_RADIUS_MI = 12; // urban ~15-20 min drive; wide enough for cannibalization reads
    const bhAll = (typeof deps.getBHFacilities === 'function' ? deps.getBHFacilities() : []) || [];
    const lineRes = serviceLines.map(l => ({ line: l, re: serviceLineToYextRe(l) }));
    if (bhAll.length && origin) {
      out.ownNetwork = bhAll
        .filter(e => e.geocodedCoordinate?.latitude)
        .map(e => {
          const lat = e.geocodedCoordinate.latitude;
          const lng = e.geocodedCoordinate.longitude;
          const matches = lineRes.filter(({ re }) => re && re.test(e.name || '')).map(({ line }) => line);
          return {
            name: e.name,
            address: e.address ? [e.address.line1, e.address.city].filter(Boolean).join(', ') : '',
            lat, lng,
            distance_mi: round(deps.haversineDistance(origin.lat, origin.lng, lat, lng), 1),
            care_type: bhCareType(e.name),
            overlapping_service_lines: matches, // non-empty = same-service BH site nearby -> cannibalization to manage
            own: true,
            source: 'yext',
            drive_time_min: null,
          };
        })
        .filter(e => e.distance_mi != null && e.distance_mi <= OWN_NETWORK_RADIUS_MI)
        // Same-service sites first (the cannibalization question), then nearest.
        .sort((a, b) => (b.overlapping_service_lines.length - a.overlapping_service_lines.length) || (a.distance_mi - b.distance_mi))
        .slice(0, 12);
      // Graft ratings from any Places-derived BH hits onto the Yext rows.
      for (const po of placesOwn) {
        const hit = out.ownNetwork.find(o => o.name && po.name &&
          (o.name.toLowerCase().includes(po.name.toLowerCase().slice(0, 20)) ||
           po.name.toLowerCase().includes(o.name.toLowerCase().slice(0, 20))));
        if (hit) { hit.rating = po.rating; hit.reviews = po.reviews; hit.place_id = po.place_id; }
        else out.ownNetwork.push(po); // Places found a BH site Yext missed - keep it
      }
      out.pullQuality.own_network = {
        source: 'yext-facility-cache', cache_size: bhAll.length,
        radius_mi: OWN_NETWORK_RADIUS_MI, found: out.ownNetwork.length,
      };
    } else {
      // No cache/origin -> legacy behavior (Places-derived only) so nothing regresses.
      out.ownNetwork = placesOwn;
      out.pullQuality.own_network = {
        source: 'places-fallback', cache_size: bhAll.length, found: placesOwn.length,
        note: origin ? 'Yext facility cache empty at request time' : 'no origin - own_network needs an address',
      };
      if (origin && !bhAll.length) t.warnings.push('own_network fell back to Places name-matching (Yext cache empty) - footprint may be incomplete');
    }

    // Drive times via batched Distance Matrix calls (10 destinations max each),
    // batches in parallel. Own-network sites get drive times too - the
    // cannibalization/coordination story is told in minutes, not miles.
    if (include.has('drive_times') && origin && (out.competitors.length || out.ownNetwork.length)) {
      const withCoords = [...out.competitors, ...out.ownNetwork].filter(c => c.lat && c.lng);
      const batches = [];
      for (let i = 0; i < withCoords.length; i += 10) batches.push(withCoords.slice(i, i + 10));
      await Promise.all(batches.map(async (batch) => {
        const dests = batch.map(c => `${c.lat},${c.lng}`).join('|');
        const dm = await executeTool('calculate_drive_times',
          { origins: `${origin.lat},${origin.lng}`, destinations: dests }, null, blockCtx());
        t.sources.add('Google Distance Matrix API');
        const err = envelopeError(dm);
        if (err) {
          t.warnings.push(`drive-time batch failed: ${err}`);
          return;
        }
        const flat = dm._rawData || dm.data || [];
        for (let j = 0; j < batch.length; j++) {
          const el = Array.isArray(flat) ? flat[j] : null;
          if (el && el.duration_seconds != null) {
            batch[j].drive_time_min = round(el.duration_seconds / 60, 1);
          }
        }
      }));
    }
    // Rank by rating × reviews so the planner gets the strongest competitors first.
    out.competitors.sort((a, b) => (b.rating || 0) * (b.reviews || 0) - (a.rating || 0) * (a.reviews || 0));
    return out;
  }, { competitors: [], ownNetwork: [] });

  // Drive-time tiering (additive): only when both competitors and drive_times
  // were requested; tierCompetitors returns null when no drive times exist.
  const tieredP = competitorsP.then(r =>
    (include.has('competitors') && include.has('drive_times'))
      ? tierCompetitors(r.value.competitors)
      : null
  );

  // Per-service-line tiering (additive): one tiered set per search term, each
  // with category-appropriate drive-time caps. For convenience categories the
  // Broader tier collapses to a one-line context summary - 20+ minute
  // "competitors" are never table rows for a proximity-decided service.
  const tieredByLineP = competitorsP.then(r => {
    if (!(include.has('competitors') && include.has('drive_times'))) return null;
    const comps = r.value.competitors || [];
    if (!comps.length) return null;
    const byLine = {};
    for (const term of new Set(comps.flatMap(c => c.service_lines || [c.service_line]).filter(Boolean))) {
      const group = comps.filter(c => (c.service_lines || [c.service_line]).includes(term));
      const caps = categoryCapsFor(term);
      const tiered = tierCompetitors(group, caps);
      if (!tiered) continue;
      tiered.caps_applied = { ...caps };
      if (caps.dropBroader && tiered.broader.length) {
        const names = tiered.broader.map(b => `${b.name} (${b.drive_time_min} min)`);
        tiered.broader_context_summary =
          `${tiered.broader.length} additional visible ${term} option(s) beyond ${caps.adjacentMax} min - ` +
          `${names.slice(0, 4).join('; ')}${names.length > 4 ? '; …' : ''} - outside typical ${term} ` +
          `drive tolerance; mention as context at most, never as table rows.`;
        tiered.broader = [];
      }
      byLine[term] = tiered;
    }
    return Object.keys(byLine).length ? byLine : null;
  });

  // ── BH locations near origin ──────────────────────────────────────────────
  const bhLocationsP = runBlock('bh_locations', async (t) => {
    if (!include.has('bh_locations') || !origin) return [];
    const broad = '%7B%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D';
    const loc = await executeTool('baptist_health_location_lookup', { filter: broad }, null, blockCtx());
    t.sources.add('Yext Live API');
    const err = envelopeError(loc);
    if (err) throw new Error(err);
    const ents = loc._rawData || loc.data || [];
    return (Array.isArray(ents) ? ents : [])
      .filter(e => e.geocodedCoordinate?.latitude)
      .map(e => ({
        name: e.name,
        lat: e.geocodedCoordinate.latitude,
        lng: e.geocodedCoordinate.longitude,
        address: e.address ? `${e.address.line1}, ${e.address.city}` : '',
        care_type: /Urgent|Same-Day|Express/i.test(e.name || '') ? 'urgent'
          : /Hospital/i.test(e.name || '') ? 'hospital' : 'specialty',
        distance_mi: round(deps.haversineDistance(origin.lat, origin.lng, e.geocodedCoordinate.latitude, e.geocodedCoordinate.longitude), 1),
      }))
      .filter(e => e.distance_mi <= 25)
      .sort((a, b) => a.distance_mi - b.distance_mi)
      .slice(0, 25);
  }, []);

  // ── Physician roster (per service line, parallel across specialties) ─────
  const physiciansP = runBlock('physicians', async (t) => {
    if (!include.has('physicians') || !serviceLines.length) return [];
    const cityHint = address && address.split(',')[1] ? address.split(',')[1].trim() : null;
    const specCalls = [];
    for (const line of serviceLines) {
      const spec = serviceLineToSpecialty(line, SPECIALTY_SYNONYMS);
      const specs = Array.isArray(spec) ? spec : (spec ? [spec] : []);
      for (const s of specs) specCalls.push({ line, s });
    }
    if (!specCalls.length) return [];
    const results = await Promise.all(specCalls.map(async ({ line, s }) => {
      const filter = buildPhysicianFilter(s, cityHint);
      const phy = await executeTool('baptist_health_physician_lookup', { filter }, null, blockCtx());
      t.sources.add('Yext Live API (Physicians)');
      return { line, s, phy };
    }));
    const seen = new Set();
    const physicians = [];
    let failures = 0;
    for (const { line, s, phy } of results) {
      const err = envelopeError(phy);
      if (err) {
        failures++;
        t.warnings.push(`physician lookup "${s}" failed: ${err}`);
        continue;
      }
      const ents = phy._rawData || phy.data || [];
      for (const e of (Array.isArray(ents) ? ents : [])) {
        const id = e.npi || e.name;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        physicians.push({
          name: e.name,
          specialty: Array.isArray(e.c_listOfSpecialties) ? e.c_listOfSpecialties.join(', ') : (e.c_listOfSpecialties || s),
          service_line: line,
          accepting: e.acceptingNewPatients ?? null,
          rating: e.c_averageReviewRating ?? null,
          reviews: e.c_reviewCount ?? null,
          city: e.address?.city || null,
        });
      }
    }
    if (failures === results.length && results.length) {
      throw new Error(`all ${results.length} physician lookups failed`);
    }
    return physicians.slice(0, 60);
  }, []);

  // ── Permits (competitive threats) ─────────────────────────────────────────
  const permitsP = runBlock('permits', async (t) => {
    if (!include.has('permits')) return [];
    const perm = await executeTool('lookup_permits', { active_only: true }, null, blockCtx());
    t.sources.add('MRA Permit Tracker');
    const err = envelopeError(perm);
    if (err) throw new Error(err);
    const pData = perm._rawData || perm.data || {};
    return (pData.permits || []).slice(0, 50).map(p => ({
      project_name: p.project_name || p.name || null,
      health_system: p.health_system || null,
      county: p.county || null,
      status: p.status || null,
      address: p.address || null,
      last_status_change_date: p.last_status_change_date || null,
    }));
  }, []);

  // ── Market news (web research) ─────────────────────────────────
  // Recent market developments, competitor moves, partnerships - the qualitative
  // context the data blocks don't carry. Returned as sourced, cited items.
  const newsP = runBlock('news', async (t) => {
    if (!include.has('news')) return [];
    const place = address || (zips.length ? `ZIP code ${zips[0]} area, Florida` : 'South Florida');
    const slLabel = serviceLines.length ? serviceLines.join(' and ') : 'healthcare';
    const q = `recent news and market developments in ${slLabel} near ${place} 2025 2026 new facility competitor expansion partnership merger acquisition`;
    const wr = await executeTool('web_research', { research_query: q }, null, blockCtx());
    t.sources.add((wr && wr._source && wr._source.api) || 'Web Search');
    const err = envelopeError(wr);
    if (err) throw new Error(err);
    const items = wr._rawData || wr.data || [];
    const news = (Array.isArray(items) ? items : []).slice(0, 6).map(r => ({
      title: r.title || null,
      url: r.url || null,
      summary: r.description || null,
    }));
    // Deepen the top stories: read the full article so the plan gets a real,
    // sourced excerpt, not just the search snippet. Bounded to the top 2.
    const toRead = news.filter(n => n.url).slice(0, 2);
    await Promise.all(toRead.map(async (n) => {
      try {
        const rp = await executeTool('read_page', { url: n.url }, null, blockCtx());
        const content = rp._rawData?.content || rp.data?.content || '';
        const ex = newsExcerpt(content);
        if (ex) { n.excerpt = ex; t.sources.add((rp && rp._source && rp._source.api) || 'Jina Reader'); }
      } catch (e) { /* keep the snippet-only item */ }
    }));
    return news;
  }, []);

  // ── Competitor review themes (DataForSEO sentiment + themes) ─────────────
  // Not just a star rating - what patients actually say about the top
  // competitors. Chains off the competitors block (and its tiering) and runs a
  // bounded, budgeted review pull per competitor.
  const reviewThemesP = runBlock('review_themes', async (t) => {
    if (!include.has('review_themes')) return [];
    const { competitors } = (await competitorsP).value;
    if (!competitors.length) return [];
    // Prefer the drive-time tiers (in-market first, then adjacent) so review
    // themes describe the competitors the market actually drives to.
    const tiered = await tieredP;
    const orderedPool = tiered ? [...tiered.in_market, ...tiered.adjacent] : [];
    const top = (orderedPool.length ? orderedPool : competitors).slice(0, 3);
    const limit = Number(body.reviews_limit) > 0 ? Number(body.reviews_limit) : 120;
    const maxWaitS = Number(process.env.MD_REVIEWS_BUDGET_S) || 120;
    const results = await Promise.all(top.map(async (c) => {
      try {
        const rr = await executeTool('google_reviews_report',
          { query: c.name, reviewsLimit: limit, include_csv: false, max_wait_s: maxWaitS }, null, blockCtx());
        const err = envelopeError(rr);
        if (err) {
          t.warnings.push(`review_themes for "${c.name}" failed: ${err}`);
          return null;
        }
        const md = rr.metadata || rr._rawData || {};
        return {
          name: c.name,
          rating: c.rating ?? md.avg_rating ?? null,
          reviews_analyzed: md.total_reviews_analyzed ?? null,
          reviews_available: md.total_reviews_available ?? c.reviews ?? null,
          top_themes: md.top_themes || [],
          sentiment_breakdown: md.sentiment_breakdown || null,
          mentioned_names: (md.mentioned_names || []).slice(0, 10),
        };
      } catch (e) {
        t.warnings.push(`review_themes for "${c.name}" failed: ${e.message}`);
        return null;
      }
    }));
    const reviewThemes = results.filter(Boolean);
    if (reviewThemes.length) t.sources.add('DataForSEO Google Reviews + theme/sentiment analysis');
    return reviewThemes;
  }, []);

  // ── Await everything (concurrently) ──────────────────────────────────────
  const [
    tradeAreaR, demographicsR, healthBehaviorsR, competitorsR,
    bhLocationsR, physiciansR, permitsR, newsR, reviewThemesR,
  ] = await Promise.all([
    tradeAreaP, demographicsP, healthBehaviorsP, competitorsP,
    bhLocationsP, physiciansP, permitsP, newsP, reviewThemesP,
  ]);
  const competitorsTiered = await tieredP;
  const competitorsTieredByLine = await tieredByLineP;
  const effectiveZips = await zipsP;

  const tradeArea = tradeAreaR.value;
  const demoByZip = demographicsR.value || {};
  const healthBehaviors = healthBehaviorsR.value;
  const competitors = competitorsR.value.competitors;
  const ownNetwork = competitorsR.value.ownNetwork;
  const bhLocations = bhLocationsR.value;
  const physicians = physiciansR.value;
  const permits = permitsR.value;
  const news = newsR.value;
  const reviewThemes = reviewThemesR.value;

  // Merge warnings + sources in a stable block order (matches the old serial
  // execution order) so responses are deterministic under concurrency.
  const blockResults = [
    tradeAreaR, demographicsR, healthBehaviorsR, competitorsR,
    bhLocationsR, physiciansR, permitsR, newsR, reviewThemesR,
  ];
  const warnings = [...originWarnings];
  const sources = new Set(originSources);
  for (const r of blockResults) {
    warnings.push(...r.warnings);
    for (const s of r.sources) sources.add(s);
  }
  const blocksFailed = blockResults.filter(r => r.failed).map(r => r.name);

  // Shape demographics[] (+ split payer_mix into its own block per scope).
  const demographics = [];
  const payerMix = [];
  for (const zip of effectiveZips) {
    const d = demoByZip[zip] || demographicIndex?.[zip] || {};
    const payer = {
      zip,
      commercial_pct: d.commercial_pct ?? null,        // private/commercial, all ages (% of civ. noninst. pop)
      public_pct: d.public_pct ?? null,                // public coverage, all ages
      uninsured_pct: d.uninsured_pct ?? null,          // uninsured, all ages
      commercial_18_64_pct: d.commercial_18_64_pct ?? null, // private (labor-force) 19-64 as % of 19-64 pop
      public_18_64_pct: d.public_18_64_pct ?? null,    // public (employed) 19-64 as % of 19-64 pop
    };
    demographics.push({
      zip,
      total_pop: d.total_pop ?? null,
      median_age: d.median_age ?? null,
      age_65_plus_pct: d.age_65_plus_pct ?? null,
      median_hhi: d.median_hhi ?? null,
      age_bands: d.age_bands || {},
      payer_mix: payer,
    });
    payerMix.push(payer);
  }

  const driveTimes = include.has('drive_times')
    ? competitors.filter(c => c.drive_time_min != null)
        .map(c => ({ name: c.name, drive_time_min: c.drive_time_min, distance_mi: c.distance_mi }))
    : [];

  // ── Evidence coverage summary ───────────────────────────────────────────
  const evidenceCoverage = {
    requested: [...include],
    zips_resolved: effectiveZips,
    zip_count: effectiveZips.length,
    has_origin: !!origin,
    has_trade_area: !!tradeArea,
    demographics_zips_with_data: demographics.filter(d => d.total_pop != null).length,
    competitors_found: competitors.length,
    own_network_found: ownNetwork.length,
    physicians_found: physicians.length,
    news_found: news.length,
    review_themes_found: reviewThemes.length,
    blocks_failed: blocksFailed,
  };

  return {
    origin,
    request: { zips, address, radius_minutes: radiusMinutes, service_lines: serviceLines, include: [...include] },
    trade_area: tradeArea,
    demographics,
    payer_mix: payerMix,
    health_behaviors: healthBehaviors,
    competitors,
    competitors_tiered: competitorsTiered,
    competitors_tiered_by_line: competitorsTieredByLine,
    own_network: ownNetwork,
    drive_times: driveTimes,
    pull_quality: {
      data_logic_version: DATA_LOGIC_VERSION,
      competitors: competitorsR.value.pullQuality || null,
    },
    bh_locations: bhLocations,
    physicians,
    permits,
    news,
    review_themes: reviewThemes,
    evidence_coverage: evidenceCoverage,
    field_definitions: FIELD_DEFINITIONS,
    sources: [...sources],
    warnings,
    generated_at: new Date().toISOString(),
  };
}

function round(n, d = 1) {
  if (n == null || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Simple param-keyed cache (deterministic params → identical response) ────
function cacheKey(body) {
  const norm = {
    v: DATA_LOGIC_VERSION, // logic changes invalidate cached responses
    zips: normalizeZips(body.zips),
    address: body.address || null,
    radius: body.radius || body.radius_minutes || null,
    service_lines: (body.service_lines || []).map(s => String(s).toLowerCase()).sort(),
    include: (body.include || []).slice().sort(),
  };
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

const _cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — Census/CDC are annual, ratings drift slowly.

/**
 * Express handler factory. Pass the server internals once at mount time.
 */
function makeMarketDataHandler(deps) {
  return async function marketDataHandler(req, res) {
    const body = req.body || {};
    const hasZips = Array.isArray(body.zips) && body.zips.length > 0;
    if (!hasZips && !body.address) {
      return res.status(400).json({ error: 'Provide at least one of: zips[] or address.' });
    }
    const key = cacheKey(body);
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.t < CACHE_TTL) {
      return res.json({ ...cached.data, _cache: 'hit' });
    }
    try {
      const data = await buildMarketData(body, deps);
      _cache.set(key, { t: Date.now(), data });
      // Bound cache size.
      if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
      return res.json({ ...data, _cache: 'miss' });
    } catch (err) {
      console.error('[market-data] Error:', err);
      return res.status(500).json({ error: err.message || 'market-data failed' });
    }
  };
}

module.exports = {
  makeMarketDataHandler,
  buildMarketData,
  serviceLineToSpecialty,
  serviceLineToSearchTerm,
  tierCompetitors,
  isIndividualPractitioner,
  // exported for testing
  _internals: {
    mergeCensusRows, buildHealthBehaviors, normalizeRadius, cacheKey,
    normalizeZips, submarketFromAddress, envelopeError,
    FIELD_DEFINITIONS,
  },
};
