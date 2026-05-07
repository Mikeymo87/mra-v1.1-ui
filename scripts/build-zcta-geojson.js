#!/usr/bin/env node
/**
 * Fetches ZCTA (ZIP Code Tabulation Area) boundary polygons for South Florida
 * from the Census Bureau's cartographic boundary files.
 *
 * Uses the 2020 ZCTA 500k resolution cartographic boundary GeoJSON (simplified, ~22MB for all US).
 * Filters to just our 195 South Florida ZIPs and saves locally.
 *
 * Usage: node scripts/build-zcta-geojson.js
 * Output: data/zcta-south-florida.geojson
 */

const fs = require('fs');
const path = require('path');

const CDC_DATA_PATH = path.join(__dirname, '..', 'data', 'cdc-places-south-florida.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'zcta-south-florida.geojson');

// Primary: Census TIGER/Line 2023 full-resolution ZCTA boundaries (most accurate)
// Download from: https://www2.census.gov/geo/tiger/TIGER2023/ZCTA520/tl_2023_us_zcta520.zip
// Convert with pyshp: python3 -c "import shapefile; ..." (see inline script below)
// Fallback: OpenDataDE community GeoJSON (500k simplified, less accurate on coastlines)
const CENSUS_GEOJSON_URL = 'https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/fl_florida_zip_codes_geo.min.json';

// Fallback: Census Bureau's own cartographic boundary file
const CENSUS_CB_URL = 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip';

async function main() {
  console.log('=== ZCTA GeoJSON Builder ===\n');

  // Read ZIP list from CDC data
  const cdcData = JSON.parse(fs.readFileSync(CDC_DATA_PATH, 'utf8'));
  const targetZips = new Set(Object.keys(cdcData));
  console.log(`Target: ${targetZips.size} ZIPs from CDC PLACES data\n`);

  // Try the Florida-specific GeoJSON first (smaller download)
  console.log('Fetching Florida ZIP code boundaries...');
  let geojson = null;

  try {
    const res = await fetch(CENSUS_GEOJSON_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    geojson = await res.json();
    console.log(`  Downloaded: ${geojson.features?.length || 0} Florida ZIPs\n`);
  } catch (err) {
    console.error(`  Florida GeoJSON failed: ${err.message}`);
    console.log('  Trying Census Bureau cartographic boundaries...\n');

    // Try the Census Bureau's ZCTA cartographic boundary file
    // This is for all US states but as GeoJSON directly
    const altUrl = 'https://raw.githubusercontent.com/arcee-ai/census-zcta-geojson/main/cb_2020_us_zcta520_500k.geojson';
    try {
      const res2 = await fetch(altUrl, { signal: AbortSignal.timeout(120000) });
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      geojson = await res2.json();
      console.log(`  Downloaded: ${geojson.features?.length || 0} US ZCTAs\n`);
    } catch (err2) {
      console.error(`  Census CB failed: ${err2.message}`);
      console.error('\nAll sources failed. Please try again later or manually download ZCTA GeoJSON.');
      process.exit(1);
    }
  }

  // Filter to our 195 South Florida ZIPs
  // The property name varies by source: ZCTA5CE20, ZCTA5CE10, or ZCTA5
  const filtered = geojson.features.filter(f => {
    const zip = f.properties.ZCTA5CE20 || f.properties.ZCTA5CE10 || f.properties.ZCTA5 || f.properties.GEOID10 || f.properties.GEOID20;
    return zip && targetZips.has(zip);
  });

  // Normalize property name to ZCTA5CE20
  for (const f of filtered) {
    const zip = f.properties.ZCTA5CE20 || f.properties.ZCTA5CE10 || f.properties.ZCTA5 || f.properties.GEOID10 || f.properties.GEOID20;
    f.properties = { ZCTA5CE20: zip };
  }

  const result = { type: 'FeatureCollection', features: filtered };

  // Verify coverage
  const fetchedZips = new Set(filtered.map(f => f.properties.ZCTA5CE20));
  const missingZips = [...targetZips].filter(z => !fetchedZips.has(z)).sort();

  console.log(`=== Results ===`);
  console.log(`Matched: ${filtered.length} / ${targetZips.size} ZIPs`);
  if (missingZips.length > 0) {
    console.log(`Missing (${missingZips.length}): ${missingZips.join(', ')}`);
  }

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result));
  const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`\nSaved: ${OUTPUT_PATH} (${sizeMB} MB)`);
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
