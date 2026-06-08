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

/**
 * Build the deterministic market-data response.
 * @param body request body
 * @param deps server internals injected from server.js
 */
async function buildMarketData(body, deps) {
  const {
    executeTool, cdcPlacesData, zctaGeoJSON, pointInIsochrone,
    SPECIALTY_SYNONYMS, demographicIndex,
  } = deps;

  const zips = Array.isArray(body.zips) ? body.zips.map(z => String(z).trim()).filter(Boolean) : [];
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

  const warnings = [];
  const sources = new Set();
  const ctx = { originCoords: null };

  // ── 1. Resolve origin ──────────────────────────────────────────────────
  let origin = null;
  if (address) {
    const enc = encodeURIComponent(address).replace(/%20/g, '+');
    const geo = await executeTool('geocode_address', { address: enc }, null, ctx);
    sources.add('Google Geocoding API');
    const r = (geo._rawData || geo.data);
    const loc = Array.isArray(r) ? r[0]?.geometry?.location : r?.geometry?.location;
    if (loc) origin = { lat: loc.lat, lng: loc.lng, label: (Array.isArray(r) ? r[0]?.formatted_address : null) || address };
    if ((geo.warnings || []).length) warnings.push(...geo.warnings.map(w => (typeof w === 'string' ? w : w.message)));
  }
  if (!origin && zips.length) {
    const c = zipCentroid(zctaGeoJSON, zips[0]);
    if (c) origin = { lat: c.lat, lng: c.lng, label: `ZIP ${zips[0]} centroid` };
  }
  if (origin) ctx.originCoords = { lat: origin.lat, lng: origin.lng };

  // ── 2. Trade area (isochrone → catchment ZIPs) ─────────────────────────
  let tradeArea = null;
  let effectiveZips = [...zips];
  if (include.has('trade_area') && origin) {
    const rangeSeconds = radiusMinutes.slice(0, 3).map(m => m * 60);
    const iso = await executeTool('drive_time_isochrone',
      { lat: origin.lat, lng: origin.lng, range: rangeSeconds }, null, ctx);
    sources.add('OpenRouteService Isochrone API');
    const isoData = iso._rawData || iso.data;
    if (isoData?.features) {
      const { zips: catchmentZips, population } =
        catchmentFromIsochrone(zctaGeoJSON, isoData, pointInIsochrone, cdcPlacesData);
      tradeArea = {
        origin,
        minutes: radiusMinutes,
        catchment_zips: catchmentZips,
        catchment_population: population,
      };
      // If caller gave no ZIPs, drive the demographic/CDC pulls off the catchment.
      if (!effectiveZips.length && catchmentZips.length) {
        // Limit to ZIPs we have CDC coverage for to keep Census calls bounded.
        effectiveZips = catchmentZips.filter(z => cdcPlacesData?.[z]).slice(0, 40);
      }
    } else {
      warnings.push('Trade-area isochrone unavailable; catchment not computed.');
    }
  }

  // ── 3. Demographics + payer mix (deterministic Census pulls) ────────────
  const demoByZip = {};
  if (include.has('demographics') && effectiveZips.length) {
    const zipList = effectiveZips.join(',');
    // Call A: population, age bands, median age, 65+.
    const ageVars = ['DP05_0001E', 'DP05_0018E', 'DP05_0024PE',
      'DP05_0005E', 'DP05_0005PE', 'DP05_0006E', 'DP05_0006PE', 'DP05_0007E', 'DP05_0007PE',
      'DP05_0008E', 'DP05_0008PE', 'DP05_0009E', 'DP05_0009PE', 'DP05_0010E', 'DP05_0010PE',
      'DP05_0011E', 'DP05_0011PE', 'DP05_0012E', 'DP05_0012PE', 'DP05_0013E', 'DP05_0013PE',
      'DP05_0014E', 'DP05_0014PE', 'DP05_0015E', 'DP05_0015PE', 'DP05_0016E', 'DP05_0016PE'];
    const callA = await executeTool('census_demographics_lookup', {
      year: '2024',
      endpoint: `/profile?get=NAME,${ageVars.join(',')}&for=zip+code+tabulation+area:${zipList}`,
    }, null, ctx);
    sources.add(callA._source?.api || 'Census ACS 5-Year');
    mergeCensusRows(demoByZip, callA._rawData || callA.data, CENSUS_FIELD_MAP, true);
    if ((callA.warnings || []).length) warnings.push(...callA.warnings.map(w => (typeof w === 'string' ? w : w.message)));

    // Call B: income + payer mix (all-ages % + 19-64 counts for commercial cohort).
    const payVars = ['DP03_0062E', 'DP03_0096PE', 'DP03_0097PE', 'DP03_0098PE',
      'DP03_0099PE', 'DP03_0102E', 'DP03_0106E', 'DP03_0111E', 'DP03_0107E'];
    const callB = await executeTool('census_demographics_lookup', {
      year: '2024',
      endpoint: `/profile?get=NAME,${payVars.join(',')}&for=zip+code+tabulation+area:${zipList}`,
    }, null, ctx);
    mergeCensusRows(demoByZip, callB._rawData || callB.data, CENSUS_FIELD_MAP, false);
    if ((callB.warnings || []).length) warnings.push(...callB.warnings.map(w => (typeof w === 'string' ? w : w.message)));

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
  }

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

  // ── 4. Health behaviors (CDC PLACES) ───────────────────────────────────
  let healthBehaviors = [];
  if (include.has('health_behaviors') && effectiveZips.length) {
    const cdc = await executeTool('cdc_health_behaviors',
      { zip_codes: effectiveZips.join(',') }, null, ctx);
    sources.add('CDC PLACES (BRFSS)');
    healthBehaviors = buildHealthBehaviors(cdc._rawData || cdc.data);
    if ((cdc.warnings || []).length) warnings.push(...cdc.warnings.map(w => (typeof w === 'string' ? w : w.message)));
  }

  // ── 5. Competitors + drive times (per service line, deduped) ────────────
  let competitors = [];
  let ownNetwork = []; // BH-owned facilities the competitor search surfaced
  const COMPETITOR_MAX_MILES = 30; // drop statewide noise; keep the real market
  if (include.has('competitors')) {
    // Anchor the Places query to a city near the origin. Prefer an explicit city
    // from the address; otherwise reverse-geocode the origin to a locality.
    let cityHint = (address && address.split(',')[1]) ? address.split(',')[1].trim() : null;
    if (!cityHint && origin) {
      const rev = await executeTool('geocode_address',
        { address: encodeURIComponent(`${origin.lat},${origin.lng}`) }, null, ctx);
      const rr = rev._rawData || rev.data;
      const comps = Array.isArray(rr) ? rr[0]?.address_components : rr?.address_components;
      cityHint = comps?.find(c => c.types?.includes('locality'))?.long_name || null;
    }
    cityHint = cityHint || 'Miami';
    const terms = serviceLines.length
      ? serviceLines.map(serviceLineToSearchTerm)
      : ['hospital'];
    const seen = new Map();
    for (const term of terms) {
      const q = encodeURIComponent(`${term} near ${cityHint} FL`).replace(/%20/g, '+');
      const comp = await executeTool('competitor_ratings_reviews', { query: q }, null, ctx);
      sources.add('Google Places Text Search');
      const places = comp._rawData || comp.data || [];
      for (const p of (Array.isArray(places) ? places : [])) {
        const key = p.place_id || p.name;
        if (!key || seen.has(key)) continue;
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
          service_line: term,
          distance_mi,
          drive_time_min: null,
        });
      }
    }
    // Split BH-owned facilities out of the competitor set. They are not
    // competitors; surface them separately so the planner knows BH's footprint
    // and never writes "our competitor is Baptist Health ...".
    for (const c of seen.values()) {
      if (isBhOwned(c.name)) ownNetwork.push({ ...c, own: true });
      else competitors.push(c);
    }

    // Drive times in one batched Distance Matrix call (10 destinations max each).
    if (include.has('drive_times') && origin && competitors.length) {
      const withCoords = competitors.filter(c => c.lat && c.lng);
      for (let i = 0; i < withCoords.length; i += 10) {
        const batch = withCoords.slice(i, i + 10);
        const dests = batch.map(c => `${c.lat},${c.lng}`).join('|');
        const dm = await executeTool('calculate_drive_times',
          { origins: `${origin.lat},${origin.lng}`, destinations: dests }, null, ctx);
        sources.add('Google Distance Matrix API');
        const flat = dm._rawData || dm.data || [];
        for (let j = 0; j < batch.length; j++) {
          const el = Array.isArray(flat) ? flat[j] : null;
          if (el && el.duration_seconds != null) {
            batch[j].drive_time_min = round(el.duration_seconds / 60, 1);
          }
        }
      }
    }
    // Rank by rating × reviews so the planner gets the strongest competitors first.
    competitors.sort((a, b) => (b.rating || 0) * (b.reviews || 0) - (a.rating || 0) * (a.reviews || 0));
  }

  const driveTimes = include.has('drive_times')
    ? competitors.filter(c => c.drive_time_min != null)
        .map(c => ({ name: c.name, drive_time_min: c.drive_time_min, distance_mi: c.distance_mi }))
    : [];

  // ── 6. BH locations near origin ─────────────────────────────────────────
  let bhLocations = [];
  if (include.has('bh_locations') && origin) {
    const broad = '%7B%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D';
    const loc = await executeTool('baptist_health_location_lookup', { filter: broad }, null, ctx);
    sources.add('Yext Live API');
    const ents = loc._rawData || loc.data || [];
    const nearby = (Array.isArray(ents) ? ents : [])
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
    bhLocations = nearby;
  }

  // ── 7. Physician roster (per service line) ──────────────────────────────
  let physicians = [];
  if (include.has('physicians') && serviceLines.length) {
    const cityHint = address && address.split(',')[1] ? address.split(',')[1].trim() : null;
    const seen = new Set();
    for (const line of serviceLines) {
      const spec = serviceLineToSpecialty(line, SPECIALTY_SYNONYMS);
      const specs = Array.isArray(spec) ? spec : (spec ? [spec] : []);
      for (const s of specs) {
        const filter = buildPhysicianFilter(s, cityHint);
        const phy = await executeTool('baptist_health_physician_lookup', { filter }, null, ctx);
        sources.add('Yext Live API (Physicians)');
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
    }
    physicians = physicians.slice(0, 60);
  }

  // ── 8. Permits (competitive threats) ────────────────────────────────────
  let permits = [];
  if (include.has('permits')) {
    const perm = await executeTool('lookup_permits', { active_only: true }, null, ctx);
    sources.add('MRA Permit Tracker');
    const pData = perm._rawData || perm.data || {};
    permits = (pData.permits || []).slice(0, 50).map(p => ({
      project_name: p.project_name || p.name || null,
      health_system: p.health_system || null,
      county: p.county || null,
      status: p.status || null,
      address: p.address || null,
      last_status_change_date: p.last_status_change_date || null,
    }));
  }

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
  };

  return {
    origin,
    request: { zips, address, radius_minutes: radiusMinutes, service_lines: serviceLines, include: [...include] },
    trade_area: tradeArea,
    demographics,
    payer_mix: payerMix,
    health_behaviors: healthBehaviors,
    competitors,
    own_network: ownNetwork,
    drive_times: driveTimes,
    bh_locations: bhLocations,
    physicians,
    permits,
    evidence_coverage: evidenceCoverage,
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
    zips: (body.zips || []).map(String).sort(),
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
  // exported for testing
  _internals: { mergeCensusRows, buildHealthBehaviors, normalizeRadius, cacheKey },
};
