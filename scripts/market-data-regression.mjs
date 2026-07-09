#!/usr/bin/env node
// Market-data regression suite. Run against a LOCAL MRA before every deploy:
//   node server.js            (in one terminal, or PORT=5055 node server.js)
//   npm run test:market       (defaults to :5000; MRA_TEST_URL overrides)
//
// Live Google/Yext APIs are exercised - this is an integration gate, not a
// unit test. Ground truth for the Coral Way case comes from Mike's manual
// Google Maps pull on July 9, 2026 (the recall failure that motivated the
// anchored-search rewrite). If this suite fails, DO NOT DEPLOY.

const BASE = process.env.MRA_TEST_URL || 'http://localhost:5000';

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; fails.push(name); console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}
const names = (arr) => (arr || []).map(c => (c.name || '').toLowerCase());
const hasName = (arr, frag) => names(arr).some(n => n.includes(frag.toLowerCase()));
const allTierRows = (t) => [...(t?.in_market || []), ...(t?.adjacent || []), ...(t?.broader || [])];

async function pull(body) {
  const r = await fetch(`${BASE}/api/market-data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /api/market-data -> ${r.status}`);
  return r.json();
}

// ── Case 1: Coral Way urgent care + imaging (the July 9 recall failure) ─────
async function coralWay() {
  console.log('\nCASE 1: 2100 SW 27th Ave - urgent care + imaging (ground truth: July 9, 2026)');
  const d = await pull({
    address: '2100 SW 27th Ave, Miami, FL 33145',
    service_lines: ['urgent care', 'imaging'],
    include: ['competitors', 'drive_times'],
  });

  const pq = d.pull_quality?.competitors;
  check('pull is anchored', pq?.method?.includes('anchored'), `method=${pq?.method}`);
  check('data_logic_version present', !!d.pull_quality?.data_logic_version);

  const byLine = d.competitors_tiered_by_line || {};
  const uc = byLine['urgent care'];
  const img = byLine['imaging center'];
  check('per-line tiers: urgent care', !!uc);
  check('per-line tiers: imaging center', !!img);

  // Recall ground truth - urgent care
  const ucRows = allTierRows(uc);
  check('UC: MD Now Coral Way found', hasName(ucRows, 'md now') && hasName(ucRows, 'coral way'));
  check('UC: MD Now Coral Way in-market', hasName(uc?.in_market, 'coral way'));
  check('UC: Miami Urgent Care found', hasName(ucRows, 'miami urgent care'));
  check('UC: UHealth Jackson Coral Gables found', hasName(ucRows, 'uhealth jackson'));
  const ucMax = Math.max(...ucRows.map(c => c.drive_time_min || 0));
  check('UC: no table row beyond 12 min cap', ucMax <= 12, `max=${ucMax}`);
  check('UC: far options demoted to summary', uc?.broader?.length === 0 && (!!uc?.broader_context_summary || (pq?.per_term?.['urgent care']?.results_returned ?? 0) <= 9));

  // Recall ground truth - imaging
  const imgRows = allTierRows(img);
  for (const frag of ['vital imaging', 'life imaging', 'imaging nation', 'stand-up mri', 'adc ambulatory']) {
    check(`IMG: ${frag} found`, hasName(imgRows, frag));
  }
  const imgMax = Math.max(...imgRows.map(c => c.drive_time_min || 0));
  check('IMG: no table row beyond 15 min cap', imgMax <= 15, `max=${imgMax}`);

  // own_network from Yext - the cannibalization data
  const own = d.own_network || [];
  check('OWN: sourced from Yext cache', d.pull_quality?.competitors?.own_network?.source === 'yext-facility-cache'
    || own.some(o => o.source === 'yext'));
  check('OWN: BH Diagnostic Imaging Coral Gables', hasName(own, 'diagnostic imaging | coral gables'));
  check('OWN: BH Diagnostic Imaging Brickell', hasName(own, 'diagnostic imaging | brickell'));
  check('OWN: BH Urgent Care Coral Gables (cannibalization case)', hasName(own, 'urgent care | coral gables'));
  check('OWN: overlapping_service_lines tagged', own.some(o => (o.overlapping_service_lines || []).length));
  check('OWN: no BH site leaked into competitors', !hasName(d.competitors, 'baptist'));

  // Legacy shape stability (other consumers)
  for (const k of ['competitors', 'competitors_tiered', 'own_network', 'drive_times', 'bh_locations', 'evidence_coverage', 'field_definitions', 'warnings']) {
    check(`legacy field: ${k}`, k in d);
  }
  const row = d.competitors[0] || {};
  for (const k of ['name', 'rating', 'reviews', 'address', 'place_id', 'lat', 'lng', 'service_line', 'distance_mi', 'drive_time_min']) {
    check(`legacy competitor row key: ${k}`, k in row);
  }
}

// ── Case 2: specialty line, different county (Broward) - default caps ───────
async function browardCardiology() {
  console.log('\nCASE 2: Plantation (Broward) - cardiology (destination category, default caps)');
  const d = await pull({
    address: '8201 W Broward Blvd, Plantation, FL 33324',
    service_lines: ['cardiology'],
    include: ['competitors', 'drive_times'],
  });
  const t = (d.competitors_tiered_by_line || {})['cardiology'];
  check('tiers present', !!t);
  check('destination category keeps Broader rows (no drop)', !t?.caps_applied?.dropBroader);
  check('competitors found (dense metro)', (d.competitors || []).length >= 5, `n=${(d.competitors || []).length}`);
  check('own_network present (BH West Broward footprint)', (d.own_network || []).length >= 1);
}

// ── Case 3: zips-only pull (no street address) still anchors + works ────────
async function zipsOnly() {
  console.log('\nCASE 3: zips-only pull (33176) - urgent care');
  const d = await pull({
    zips: ['33176'],
    service_lines: ['urgent care'],
    include: ['competitors', 'drive_times'],
  });
  check('competitors found', (d.competitors || []).length >= 3);
  check('legacy competitors_tiered present', !!d.competitors_tiered);
  check('pull_quality reports its method honestly', !!d.pull_quality?.competitors?.method);
}

try {
  await coralWay();
  await browardCardiology();
  await zipsOnly();
} catch (e) {
  console.error('\nSuite aborted:', e.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed${failed ? ' - DO NOT DEPLOY' : ' - safe to deploy'}`);
if (fails.length) console.log('Failed checks:\n  - ' + fails.join('\n  - '));
process.exit(failed ? 1 : 0);
