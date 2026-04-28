/**
 * Census Cache Pre-Seed Script — Comprehensive Healthcare Marketing Variables
 * Fetches Census ACS data for all 195 South Florida ZIPs and saves to census-cache.json
 *
 * Run: node scripts/preseed-census.js
 * Takes ~15-20 minutes (195 ZIPs × 7 variable sets × 500ms delay)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CENSUS_KEY = process.env.CENSUS_API_KEY;
if (!CENSUS_KEY) { console.error('CENSUS_API_KEY not found in .env'); process.exit(1); }

// Load ZIP list from CDC data (same 195 ZIPs the MRA covers)
const cdcPath = path.join(__dirname, '..', 'data', 'cdc-places-south-florida.json');
const cdcData = JSON.parse(fs.readFileSync(cdcPath, 'utf8'));
const ZIPS = Object.keys(cdcData).sort();
console.log(`Found ${ZIPS.length} ZIPs to cache\n`);

// Load existing cache
const cachePath = path.join(__dirname, '..', 'data', 'census-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) {}
const existingCount = Object.keys(cache).length;
console.log(`Existing cache: ${existingCount} entries\n`);

// ── Variable Sets (max 25 vars per call) ──────────────────────────────────
// Organized for healthcare marketing intelligence
const VARIABLE_SETS = [
  {
    name: '1/7 Population + Age Brackets',
    // Total pop, male, female, age brackets: <5, 5-9, 10-14, 15-19, 20-24, 25-34, 35-44, 45-54, 55-59, 60-64, 65-74, 75-84, 85+
    endpoint: (zip) => `/profile?get=NAME,DP05_0001E,DP05_0002E,DP05_0002PE,DP05_0003E,DP05_0003PE,DP05_0005E,DP05_0006E,DP05_0007E,DP05_0008E,DP05_0009E,DP05_0010E,DP05_0011E,DP05_0012E,DP05_0013E,DP05_0014E,DP05_0015E,DP05_0016E,DP05_0017E&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '2/7 Age Bracket Percentages',
    // Age bracket %s + key age group totals (18+, 21+, 62+, 65+, median age)
    endpoint: (zip) => `/profile?get=NAME,DP05_0005PE,DP05_0006PE,DP05_0007PE,DP05_0008PE,DP05_0009PE,DP05_0010PE,DP05_0011PE,DP05_0012PE,DP05_0013PE,DP05_0014PE,DP05_0015PE,DP05_0016PE,DP05_0017PE,DP05_0021E,DP05_0021PE,DP05_0024E,DP05_0024PE,DP05_0018E&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '3/7 Race, Ethnicity, Language',
    // Hispanic %, White %, Black %, Asian %, Two+ races %, Spanish at home %, Other language %, Foreign born %
    endpoint: (zip) => `/profile?get=NAME,DP05_0071E,DP05_0071PE,DP05_0077PE,DP05_0078PE,DP05_0080PE,DP05_0082PE,DP02_0113PE,DP02_0116PE,DP02_0096PE&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '4/7 Income, Education, Employment',
    // Median HH income, Mean HH income, Per capita income, Bachelor+ %, Grad+ %, Employment rate, Unemployment %,
    // Poverty %, Households, Families
    endpoint: (zip) => `/profile?get=NAME,DP03_0062E,DP03_0063E,DP03_0088E,DP02_0068PE,DP02_0067PE,DP02_0072PE,DP03_0004PE,DP03_0005PE,DP03_0119PE,DP02_0001E,DP02_0002E&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '5/7 Payer Mix — Private, Public, Uninsured',
    // With insurance %, Private %, Public %, Uninsured %, + counts for each
    // Also: 18-64 private %, 18-64 public %, 18-64 uninsured % (the BH targeting sweet spot)
    endpoint: (zip) => `/profile?get=NAME,DP03_0096PE,DP03_0097E,DP03_0097PE,DP03_0098E,DP03_0098PE,DP03_0099E,DP03_0099PE,DP03_0101PE,DP03_0102PE,DP03_0103PE,DP03_0104PE,DP03_0105PE,DP03_0106PE&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '6/7 Payer Mix — Medicare/Medicaid (Subject Table)',
    // Medicare enrollment, Medicaid enrollment, Employer-based %, Direct purchase %
    endpoint: (zip) => `/subject?get=NAME,S2704_C02_002E,S2704_C02_006E,S2704_C02_003E,S2704_C02_004E&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: '7/7 Housing, Disability, Veterans',
    // Owner-occupied %, Renter %, Median home value, Median rent, Disability %, Veterans, With vehicle %, Internet %
    endpoint: (zip) => `/profile?get=NAME,DP04_0046PE,DP04_0047PE,DP04_0089E,DP04_0134E,DP02_0072PE,DP02_0071E,DP04_0058PE,DP02_0153PE&for=zip+code+tabulation+area:${zip}`
  }
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCensus(endpoint, year = '2024') {
  const url = `https://api.census.gov/data/${year}/acs/acs5${endpoint}&key=${CENSUS_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) return { data: await res.json(), year };
    // Try 2023 fallback
    if (year === '2024') return fetchCensus(endpoint, '2023');
    return null;
  } catch (e) {
    if (year === '2024') return fetchCensus(endpoint, '2023');
    return null;
  }
}

async function main() {
  let cached = 0, failed = 0, skipped = 0;
  const total = ZIPS.length * VARIABLE_SETS.length;
  let done = 0;
  const startTime = Date.now();

  console.log(`Total API calls needed: up to ${total}`);
  console.log(`Estimated time: ~${Math.ceil(total * 0.5 / 60)} minutes\n`);

  for (const zip of ZIPS) {
    for (const varSet of VARIABLE_SETS) {
      const cacheKey = varSet.endpoint(zip);
      done++;

      // Skip if already cached and less than 90 days old
      if (cache[cacheKey]?.timestamp && (Date.now() - cache[cacheKey].timestamp) < 90 * 24 * 60 * 60 * 1000) {
        skipped++;
        continue;
      }

      const result = await fetchCensus(cacheKey);
      if (result) {
        cache[cacheKey] = { data: result.data, year: result.year, timestamp: Date.now() };
        cached++;
      } else {
        failed++;
        console.log(`  FAILED: ZIP ${zip} — ${varSet.name}`);
      }

      // Progress every 20 calls
      if (done % 20 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const remaining = (((total - done) * 0.5) / 60).toFixed(1);
        process.stdout.write(`\r  Progress: ${done}/${total} | Cached: ${cached} | Skipped: ${skipped} | Failed: ${failed} | ${elapsed}m elapsed, ~${remaining}m remaining`);
      }

      // Save cache every 100 calls (prevent data loss on crash)
      if (cached > 0 && cached % 100 === 0) {
        fs.writeFileSync(cachePath, JSON.stringify(cache));
      }

      await sleep(500); // Census API rate limit
    }
  }

  // Final save
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\nDone in ${elapsed} minutes!`);
  console.log(`Cache now has ${Object.keys(cache).length} entries`);
  console.log(`  New: ${cached} | Skipped (already cached): ${skipped} | Failed: ${failed}`);

  // Reminder: re-run every 6 months for fresh Census/ACS data
  const nextRun = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  console.log(`\n⏰ REMINDER: Re-run this script by ${nextRun.toISOString().split('T')[0]} to pick up new Census ACS data.`);
  console.log(`   Also re-run scripts/build-zcta-geojson.js if ZIP boundaries change.`);
  console.log(`   CDC PLACES data (data/cdc-places-south-florida.json) should also be refreshed annually.`);
}

main().catch(e => { console.error(e); process.exit(1); });
