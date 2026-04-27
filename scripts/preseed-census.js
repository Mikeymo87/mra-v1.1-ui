/**
 * Census Cache Pre-Seed Script
 * Fetches Census ACS data for all 195 South Florida ZIPs and saves to census-cache.json
 * Run: node scripts/preseed-census.js
 * Takes ~7 minutes (780 API calls with 500ms delay)
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

// The 4 variable sets to cache per ZIP
const VARIABLE_SETS = [
  {
    name: 'Population + Age Distribution',
    endpoint: (zip) => `/profile?get=NAME,DP05_0001E,DP05_0005E,DP05_0005PE,DP05_0006E,DP05_0006PE,DP05_0007E,DP05_0007PE,DP05_0008E,DP05_0008PE,DP05_0009E,DP05_0009PE,DP05_0010E,DP05_0010PE,DP05_0011E,DP05_0011PE,DP05_0012E,DP05_0012PE,DP05_0013E,DP05_0013PE,DP05_0014E,DP05_0014PE,DP05_0015E,DP05_0015PE,DP05_0016E,DP05_0016PE&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: 'Income, Education, Language',
    endpoint: (zip) => `/profile?get=NAME,DP03_0062E,DP02_0068PE,DP02_0113PE,DP02_0072PE,DP03_0027PE,DP03_0009PE,DP04_0046PE,DP05_0002PE,DP05_0003PE,DP05_0019PE,DP05_0024PE&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: 'Payer Mix (Commercial/Uninsured)',
    endpoint: (zip) => `/profile?get=NAME,DP03_0097E,DP03_0097PE,DP03_0099E,DP03_0099PE&for=zip+code+tabulation+area:${zip}`
  },
  {
    name: 'Payer Mix (Medicare/Medicaid)',
    endpoint: (zip) => `/subject?get=NAME,S2704_C02_002E,S2704_C02_006E&for=zip+code+tabulation+area:${zip}`
  }
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCensus(endpoint, year = '2024') {
  const url = `https://api.census.gov/data/${year}/acs/acs5${endpoint}&key=${CENSUS_KEY}`;
  try {
    const res = await fetch(url);
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
        process.stdout.write(`\r  Progress: ${done}/${total} | Cached: ${cached} | Skipped: ${skipped} | Failed: ${failed}`);
      }

      await sleep(500); // Rate limit
    }
  }

  // Save cache
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`\n\nDone! Cache now has ${Object.keys(cache).length} entries`);
  console.log(`  New: ${cached} | Skipped (already cached): ${skipped} | Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
