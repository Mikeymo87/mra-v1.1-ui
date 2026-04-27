/**
 * MRA v3 Sprint 2 Regression Tests
 * Run: node test/regression.js
 */

process.env.PORT = '0';
const {
  envelope, normalizeCity, classifyIntent, detectMode, detectPlanType,
  extractServiceLines, createEvidenceCoverage, updateEvidenceCoverage,
  checkEvidenceCoverage, SPECIALTY_SYNONYMS, CITY_ALIASES, SERVICE_LINE_KEYWORDS,
  buildSystemPrompt, warn, haversineDistance
} = require('../server');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ── Mode Detection ─────────────────────────────────────────────
console.log('\n\u2500\u2500 Mode Detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Marketing plan query → marketing_plan mode', () => {
  assert.strictEqual(detectMode('For Section 5 of the marketing plan'), 'marketing_plan');
});

test('Section number → marketing_plan mode', () => {
  assert.strictEqual(detectMode('Section 4 competitive landscape'), 'marketing_plan');
});

test('Ad-hoc research → general_research mode', () => {
  assert.strictEqual(detectMode('Pull reviews for Memorial Pembroke Pines'), 'general_research');
});

test('Simple question → general_research mode', () => {
  assert.strictEqual(detectMode('What BH cardiologists are near Weston?'), 'general_research');
});

// ── Plan Type Detection ────────────────────────────────────────
console.log('\n\u2500\u2500 Plan Type Detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Facility opening detected', () => {
  assert.strictEqual(detectPlanType('Facility Opening: Multi-Specialty Medical Center'), 'facility_opening');
});

test('New center detected as facility opening', () => {
  assert.strictEqual(detectPlanType('new medical center at 18503 Pines Blvd'), 'facility_opening');
});

test('Partnership launch detected', () => {
  assert.strictEqual(detectPlanType('Partnership Launch: Baptist Health replacing UHealth for One Medical'), 'partnership_launch');
});

test('Service line plan detected', () => {
  assert.strictEqual(detectPlanType('Service line expansion for cardiology in Broward'), 'service_line');
});

test('Brand plan detected', () => {
  assert.strictEqual(detectPlanType('System-wide brand awareness campaign'), 'brand_system');
});

test('Generic query → null plan type', () => {
  assert.strictEqual(detectPlanType('What competitors are near Brickell?'), null);
});

test('"expand the radius" does NOT trigger service_line', () => {
  assert.strictEqual(detectPlanType('expand the radius to 10 miles'), null);
});

// ── Service Line Extraction ────────────────────────────────────
console.log('\n\u2500\u2500 Service Line Extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Extracts cardiology from query', () => {
  const lines = extractServiceLines('competitive landscape for cardiology');
  assert.ok(lines.includes('cardiology'));
});

test('Extracts multiple service lines', () => {
  const lines = extractServiceLines('Service lines: Primary Care, Urgent Care, Cardiology, Orthopedics, Imaging');
  assert.ok(lines.includes('primary_care'));
  assert.ok(lines.includes('urgent_care'));
  assert.ok(lines.includes('cardiology'));
  assert.ok(lines.includes('orthopedics'));
  assert.ok(lines.includes('imaging'));
});

test('Multi-specialty with no specifics → default set', () => {
  const lines = extractServiceLines('multi-specialty medical center');
  assert.ok(lines.includes('primary_care'));
  assert.ok(lines.includes('cardiology'));
  assert.ok(lines.includes('orthopedics'));
  assert.ok(lines.includes('imaging'));
});

test('Multi-specialty WITH specifics → uses specifics', () => {
  const lines = extractServiceLines('multi-specialty center with neurology and oncology');
  assert.ok(lines.includes('neurology'));
  assert.ok(lines.includes('oncology'));
});

test('No service lines in query → empty array', () => {
  const lines = extractServiceLines('What competitors are near Brickell?');
  assert.strictEqual(lines.length, 0);
});

// ── Intent Classification ──────────────────────────────────────
console.log('\n\u2500\u2500 Intent Classification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Demographics query → demographics only', () => {
  const intents = classifyIntent('demographics for ZIP 33027');
  assert.ok(intents.includes('demographics'));
  assert.ok(!intents.includes('locations'));
  assert.ok(!intents.includes('psychographic'));
});

test('Section 4 competitive → competitive + locations, NOT psychographic', () => {
  const intents = classifyIntent('For Section 4 of the marketing plan. Competitive landscape.');
  assert.ok(intents.includes('competitive'));
  assert.ok(intents.includes('locations'));
  assert.ok(!intents.includes('psychographic'), 'Section 4 should NOT load psychographic');
});

test('Section 5 → demographics + psychographic', () => {
  const intents = classifyIntent('For Section 5 of the marketing plan. Demographics.');
  assert.ok(intents.includes('demographics'));
  assert.ok(intents.includes('psychographic'));
});

test('Review query → competitive (general research)', () => {
  const intents = classifyIntent('Pull reviews for Memorial Pembroke Pines');
  assert.ok(intents.includes('competitive'));
  assert.ok(!intents.includes('psychographic'));
});

test('Trade area query → trade_area intent', () => {
  const intents = classifyIntent('What ZIPs are within 15 minutes of 18503 Pines Blvd?');
  assert.ok(intents.includes('trade_area'));
});

// ── Specialty Synonyms ─────────────────────────────────────────
console.log('\n\u2500\u2500 Specialty Synonyms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('primary care → array [Internal Medicine, Family Medicine]', () => {
  const mapped = SPECIALTY_SYNONYMS['primary care'];
  assert.ok(Array.isArray(mapped), 'Should be an array');
  assert.ok(mapped.includes('Internal Medicine'));
  assert.ok(mapped.includes('Family Medicine'));
});

test('pcp → array [Family Medicine, Internal Medicine]', () => {
  const mapped = SPECIALTY_SYNONYMS['pcp'];
  assert.ok(Array.isArray(mapped));
});

test('heart doctor → string Cardio', () => {
  assert.strictEqual(SPECIALTY_SYNONYMS['heart doctor'], 'Cardio');
});

// ── City Alias ─────────────────────────────────────────────────
console.log('\n\u2500\u2500 City Aliases \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Ft Lauderdale → Fort Lauderdale', () => {
  assert.strictEqual(normalizeCity('Ft Lauderdale'), 'Fort Lauderdale');
});

test('hallandale → Hallandale Beach', () => {
  assert.strictEqual(normalizeCity('hallandale'), 'Hallandale Beach');
});

test('null → null', () => {
  assert.strictEqual(normalizeCity(null), null);
});

// ── Envelope ───────────────────────────────────────────────────
console.log('\n\u2500\u2500 Envelope \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Empty array → status: empty', () => {
  assert.strictEqual(envelope('Test', 'url', '2026', []).status, 'empty');
});

test('Array with items → status: success', () => {
  assert.strictEqual(envelope('Test', 'url', '2026', [{a:1}]).status, 'success');
});

test('Error → status: failed', () => {
  assert.strictEqual(envelope('Test', 'url', '2026', {error: 'x'}).status, 'failed');
});

// ── Warning Helper ─────────────────────────────────────────────
console.log('\n\u2500\u2500 Warnings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('warn() creates structured warning', () => {
  const w = warn('high', 'CITY_MISMATCH', 'test message');
  assert.strictEqual(w.severity, 'high');
  assert.strictEqual(w.code, 'CITY_MISMATCH');
  assert.strictEqual(w.message, 'test message');
});

// ── Evidence Coverage ──────────────────────────────────────────
console.log('\n\u2500\u2500 Evidence Coverage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Competitive query with no BH search → missing evidence', () => {
  const ev = createEvidenceCoverage('marketing_plan', 'facility_opening', ['competitive'], ['cardiology']);
  updateEvidenceCoverage(ev, 'geocode_address', {});
  updateEvidenceCoverage(ev, 'competitor_ratings_reviews', { query: 'cardiology+Pembroke+Pines' });
  // No BH location search!
  const result = checkEvidenceCoverage(ev);
  assert.ok(result.missing.length > 0, 'Should flag missing BH search');
  assert.ok(result.missing.some(m => m.includes('BH locations')));
});

test('Competitive query with all evidence → no gaps', () => {
  const ev = createEvidenceCoverage('marketing_plan', 'facility_opening', ['competitive'], ['cardiology']);
  updateEvidenceCoverage(ev, 'geocode_address', {});
  updateEvidenceCoverage(ev, 'baptist_health_location_lookup', { filter: '%7B%22name%22%3A%7B%22%24contains%22%3A%22Cardio%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D' });
  updateEvidenceCoverage(ev, 'competitor_ratings_reviews', { query: 'cardiology+Pembroke+Pines' });
  updateEvidenceCoverage(ev, 'calculate_drive_times', {});
  const result = checkEvidenceCoverage(ev);
  assert.strictEqual(result.missing.length, 0, `Should have no gaps, got: ${result.missing.join('; ')}`);
});

test('Demographics query without Census → missing evidence', () => {
  const ev = createEvidenceCoverage('marketing_plan', null, ['demographics'], []);
  // No census call!
  const result = checkEvidenceCoverage(ev);
  assert.ok(result.missing.some(m => m.includes('Census')));
});

test('Psychographic without CDC → missing evidence', () => {
  const ev = createEvidenceCoverage('marketing_plan', null, ['psychographic'], []);
  updateEvidenceCoverage(ev, 'census_demographics_lookup', {});
  // No CDC call!
  const result = checkEvidenceCoverage(ev);
  assert.ok(result.missing.some(m => m.includes('CDC')));
});

// ── Haversine ──────────────────────────────────────────────────
console.log('\n\u2500\u2500 Haversine Distance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Known distance: Pembroke Pines to Miami Beach ~20 miles', () => {
  const d = haversineDistance(26.01, -80.40, 25.79, -80.13);
  assert.ok(d > 15 && d < 25, `Expected ~20 miles, got ${d.toFixed(1)}`);
});

test('Same point → 0 miles', () => {
  assert.strictEqual(haversineDistance(25.7, -80.3, 25.7, -80.3), 0);
});

// ── Prompt Builder ─────────────────────────────────────────────
console.log('\n\u2500\u2500 Prompt Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

test('Competitive prompt does NOT include adjacency map', () => {
  const prompt = buildSystemPrompt('competitors near Brickell');
  assert.ok(!prompt.includes('SOUTH FLORIDA CITY ADJACENCY MAP'));
});

test('Plan mode includes plan type lens', () => {
  const prompt = buildSystemPrompt('For Section 4 of the marketing plan. Facility Opening.');
  assert.ok(prompt.includes('PLAN CONTEXT FOR THIS QUERY'));
  assert.ok(prompt.includes('facility_opening'));
});

test('Service lines injected into prompt', () => {
  const prompt = buildSystemPrompt('Section 4 competitive. Service lines: Cardiology, Orthopedics, Imaging');
  assert.ok(prompt.includes('SERVICE LINES TO ANALYZE'));
  assert.ok(prompt.includes('cardiology'));
  assert.ok(prompt.includes('orthopedics'));
  assert.ok(prompt.includes('imaging'));
});

test('General research query has NO plan context block', () => {
  const prompt = buildSystemPrompt('Pull reviews for Memorial Pembroke Pines');
  assert.ok(!prompt.includes('PLAN CONTEXT FOR THIS QUERY'));
});

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`);
if (failed > 0) process.exit(1);
