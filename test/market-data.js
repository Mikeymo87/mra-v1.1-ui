/**
 * Market-Data Unit Tests (tierCompetitors, isIndividualPractitioner, normalization)
 * Run: node test/market-data.js
 */

const { tierCompetitors, isIndividualPractitioner, _internals } = require('../marketData');
const { normalizeZips, submarketFromAddress } = _internals;
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ── isIndividualPractitioner ───────────────────────────────────
console.log('\n── isIndividualPractitioner ────────────────────────\n');

test('"John Smith, MD" → individual (credential suffix)', () => {
  assert.strictEqual(isIndividualPractitioner('John Smith, MD'), true);
});

test('"Dr. Ana Perez" → individual (Dr. prefix, no facility words)', () => {
  assert.strictEqual(isIndividualPractitioner('Dr. Ana Perez'), true);
});

test('"Maria Gomez, DPM" → individual (credential suffix)', () => {
  assert.strictEqual(isIndividualPractitioner('Maria Gomez, DPM'), true);
});

test('"OrthoNOW Doral" → NOT individual', () => {
  assert.strictEqual(isIndividualPractitioner('OrthoNOW Doral'), false);
});

test('"Miami Orthopedic Group" → NOT individual', () => {
  assert.strictEqual(isIndividualPractitioner('Miami Orthopedic Group'), false);
});

test('"Baptist Health Orthopedic Care" → NOT individual', () => {
  assert.strictEqual(isIndividualPractitioner('Baptist Health Orthopedic Care'), false);
});

test('"Kendall Sports Medicine Clinic" → NOT individual', () => {
  assert.strictEqual(isIndividualPractitioner('Kendall Sports Medicine Clinic'), false);
});

test('Bare person-name shape "Ana Perez" → individual', () => {
  assert.strictEqual(isIndividualPractitioner('Ana Perez'), true);
});

test('"Dr. Smith Orthopedic Institute" → NOT individual (facility words win)', () => {
  assert.strictEqual(isIndividualPractitioner('Dr. Smith Orthopedic Institute'), false);
});

test('Empty / null names → NOT individual', () => {
  assert.strictEqual(isIndividualPractitioner(''), false);
  assert.strictEqual(isIndividualPractitioner(null), false);
});

// ── tierCompetitors: Doral case ────────────────────────────────
console.log('\n── tierCompetitors: Doral case ─────────────────────\n');

const doralCompetitors = [
  { name: 'OrthoNOW Doral', drive_time_min: 5.1, rating: 4.8, reviews: 343, address: '8459 NW 53rd Terrace, Doral, FL 33166, USA' },
  { name: 'X Orthopedic Group', drive_time_min: 13.5, rating: 4.6, reviews: 220, address: '456 W 49th St, Hialeah, FL 33012, USA' },
  { name: 'Y Sports Medicine', drive_time_min: 16.2, rating: 4.9, reviews: 510, address: '789 Brickell Ave, Miami, FL 33131, USA' },
  { name: 'Z Spine Center', drive_time_min: 23.1, rating: 4.2, reviews: 88, address: '1010 Federal Hwy, Fort Lauderdale, FL 33301, USA' },
  { name: 'John Smith, MD', drive_time_min: 4.2, rating: 5.0, reviews: 41 },
  { name: 'Dr. Ana Perez', drive_time_min: 7.9, rating: 4.9, reviews: 120 },
  { name: 'Maria Gomez, DPM', drive_time_min: 11.0, rating: 4.7, reviews: 33 },
  { name: 'Luis Fernandez, PA-C', drive_time_min: 14.3, rating: 4.8, reviews: 19 },
  { name: 'Dr. Robert Chan', drive_time_min: 18.8, rating: 4.5, reviews: 66 },
];
const doralTiered = tierCompetitors(doralCompetitors);

test('in_market is exactly [OrthoNOW Doral]', () => {
  assert.ok(doralTiered, 'tiered result should not be null');
  assert.strictEqual(doralTiered.in_market.length, 1);
  assert.strictEqual(doralTiered.in_market[0].name, 'OrthoNOW Doral');
});

test('adjacent contains X Orthopedic Group and Y Sports Medicine', () => {
  const names = doralTiered.adjacent.map(c => c.name);
  assert.ok(names.includes('X Orthopedic Group'), `adjacent was: ${names.join(', ')}`);
  assert.ok(names.includes('Y Sports Medicine'), `adjacent was: ${names.join(', ')}`);
  assert.strictEqual(doralTiered.adjacent.length, 2);
});

test('broader contains Z Spine Center', () => {
  const names = doralTiered.broader.map(c => c.name);
  assert.ok(names.includes('Z Spine Center'), `broader was: ${names.join(', ')}`);
});

test('all 5 individuals flagged, never dropped', () => {
  assert.strictEqual(doralTiered.individual_practitioners.length, 5);
  assert.ok(doralTiered.individual_practitioners.every(c => c.individual_practitioner === true));
  const names = doralTiered.individual_practitioners.map(c => c.name).sort();
  assert.deepStrictEqual(names, ['Dr. Ana Perez', 'Dr. Robert Chan', 'John Smith, MD', 'Luis Fernandez, PA-C', 'Maria Gomez, DPM']);
});

test('adjacent tier is rating×reviews ordered (Y before X)', () => {
  assert.strictEqual(doralTiered.adjacent[0].name, 'Y Sports Medicine');
  assert.strictEqual(doralTiered.adjacent[1].name, 'X Orthopedic Group');
});

test('adjacent entries carry submarket parsed from address', () => {
  const byName = Object.fromEntries(doralTiered.adjacent.map(c => [c.name, c.submarket]));
  assert.strictEqual(byName['X Orthopedic Group'], 'Hialeah');
  assert.strictEqual(byName['Y Sports Medicine'], 'Miami');
});

test('nearest_comparable is null when in_market is populated', () => {
  assert.strictEqual(doralTiered.nearest_comparable, null);
});

test('method string is present and mentions the Google Places cap', () => {
  assert.ok(typeof doralTiered.method === 'string' && doralTiered.method.length > 0);
  assert.ok(/google places/i.test(doralTiered.method));
});

// ── tierCompetitors: gap rule edges ────────────────────────────
console.log('\n── tierCompetitors: gap rule ───────────────────────\n');

function mkFacilities(times) {
  return times.map((t, i) => ({
    name: `Facility Medical Center ${i + 1}`,
    drive_time_min: t, rating: 4.0, reviews: 100,
    address: `${i + 1}00 Main St, Miami, FL 33131, USA`,
  }));
}

test('[5.1, 6.0, 7.2] all ≤10 with no 1.5x jump → all three in-market', () => {
  const tiered = tierCompetitors(mkFacilities([5.1, 6.0, 7.2]));
  assert.strictEqual(tiered.in_market.length, 3);
  assert.strictEqual(tiered.adjacent.length, 0);
});

test('[5.1, 13.5] → only the first is in-market', () => {
  const tiered = tierCompetitors(mkFacilities([5.1, 13.5]));
  assert.strictEqual(tiered.in_market.length, 1);
  assert.strictEqual(tiered.in_market[0].drive_time_min, 5.1);
  assert.strictEqual(tiered.adjacent.length, 1);
});

test('[4.0, 9.0] → jump under the 10-min cap still cuts (9 > 4×1.5, gap ≥3)', () => {
  const tiered = tierCompetitors(mkFacilities([4.0, 9.0]));
  assert.strictEqual(tiered.in_market.length, 1);
  assert.strictEqual(tiered.in_market[0].drive_time_min, 4.0);
});

test('[4.0, 5.5] → below both jump gates → both in-market', () => {
  const tiered = tierCompetitors(mkFacilities([4.0, 5.5]));
  assert.strictEqual(tiered.in_market.length, 2);
});

test('[2.0, 4.5] → ratio jump (4.5 > 3.0) but gap 2.5 < 3 min → both in-market', () => {
  const tiered = tierCompetitors(mkFacilities([2.0, 4.5]));
  assert.strictEqual(tiered.in_market.length, 2);
});

// ── tierCompetitors: thin market ───────────────────────────────
console.log('\n── tierCompetitors: thin market ────────────────────\n');

test('all destinations >10 min → in_market empty + nearest_comparable set', () => {
  const tiered = tierCompetitors(mkFacilities([12.0, 15.5, 22.0]));
  assert.strictEqual(tiered.in_market.length, 0);
  assert.ok(tiered.nearest_comparable, 'nearest_comparable should be set');
  assert.strictEqual(tiered.nearest_comparable.drive_time_min, 12.0);
  assert.ok(typeof tiered.nearest_comparable.note === 'string' && tiered.nearest_comparable.note.length > 0);
});

test('no drive times at all → returns null', () => {
  assert.strictEqual(tierCompetitors([{ name: 'A Clinic', drive_time_min: null }]), null);
  assert.strictEqual(tierCompetitors([]), null);
  assert.strictEqual(tierCompetitors(null), null);
});

test('only individuals with drive times → in_market empty, individuals flagged, nearest_comparable null', () => {
  const tiered = tierCompetitors([
    { name: 'John Smith, MD', drive_time_min: 3.0, rating: 5.0, reviews: 10 },
    { name: 'Dr. Ana Perez', drive_time_min: 6.0, rating: 4.9, reviews: 20 },
  ]);
  assert.strictEqual(tiered.in_market.length, 0);
  assert.strictEqual(tiered.individual_practitioners.length, 2);
  // No destination facilities exist, so there is no comparable facility either.
  assert.strictEqual(tiered.nearest_comparable, null);
});

test('competitors without drive_time_min do not participate in tiers', () => {
  const tiered = tierCompetitors([
    { name: 'Near Medical Center', drive_time_min: 5.0, rating: 4.5, reviews: 100, address: '1 Main St, Doral, FL 33166, USA' },
    { name: 'No-Route Medical Center', drive_time_min: null, rating: 4.9, reviews: 900 },
  ]);
  assert.strictEqual(tiered.in_market.length, 1);
  assert.strictEqual(tiered.in_market[0].name, 'Near Medical Center');
  const all = [...tiered.in_market, ...tiered.adjacent, ...tiered.broader, ...tiered.individual_practitioners];
  assert.ok(!all.some(c => c.name === 'No-Route Medical Center'));
});

// ── ZIP normalization ──────────────────────────────────────────
console.log('\n── ZIP normalization ────────────────────────────\n');

test('dedupes, trims, stringifies, and sorts', () => {
  assert.deepStrictEqual(
    normalizeZips([' 33178', '33122', 33178, '', null, '33126', '33178 ']),
    ['33122', '33126', '33178']
  );
});

test('order-independent: shuffled input → identical output', () => {
  const a = normalizeZips(['33178', '33122', '33126', '33172', '33166']);
  const b = normalizeZips(['33166', '33172', '33126', '33122', '33178']);
  assert.deepStrictEqual(a, b);
});

test('empty / missing input → empty array', () => {
  assert.deepStrictEqual(normalizeZips(undefined), []);
  assert.deepStrictEqual(normalizeZips([]), []);
});

// ── Submarket parsing ──────────────────────────────────────────
console.log('\n── Submarket parsing ────────────────────────────\n');

test('standard Google formatted_address → city', () => {
  assert.strictEqual(submarketFromAddress('8459 NW 53rd Terrace, Doral, FL 33166, USA'), 'Doral');
});

test('address without country segment → city', () => {
  assert.strictEqual(submarketFromAddress('456 W 49th St, Hialeah, FL 33012'), 'Hialeah');
});

test('empty address → null', () => {
  assert.strictEqual(submarketFromAddress(''), null);
  assert.strictEqual(submarketFromAddress(null), null);
});

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────\n`);
if (failed > 0) process.exit(1);
