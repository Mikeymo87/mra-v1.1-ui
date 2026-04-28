# MRA Pre-Seed Plan — Reduce Cost & Latency

## Already Pre-Seeded
| Data | Source | File | Coverage | Refresh |
|------|--------|------|----------|---------|
| CDC PLACES (33 health measures) | CDC BRFSS 2023 | `data/cdc-places-south-florida.json` (756KB) | 195 ZIPs | Annual |
| Census demographics (7 variable sets) | Census ACS 5-Year | `data/census-cache.json` (732KB) | 195 ZIPs × 7 sets = 1,365 entries | Every 6 months |
| One Medical locations | Manual | `data/one-medical-locations.json` (3.5KB) | 7 clinics | As needed |
| ZIP boundaries (ZCTA polygons) | Census TIGER | `data/zcta-south-florida.geojson` (1.8MB) | 195 ZIPs | Rarely changes |
| CDC benchmarks (percentiles) | Computed at startup | `data/zip-benchmarks.json` (3.8KB) | 33 measures | Auto-computed |

## Priority 1: Yext BH Facilities (HIGH impact, easy)
**Current:** Every "find BH locations" query makes a live Yext API call (~500ms each). A single "all locations" query can make 19 Yext calls (one per care type keyword).
**Opportunity:** BH has ~400 facilities total. This data changes rarely (new facility openings are quarterly events). Pre-seed ALL facilities into a local JSON file.
- **Script:** `scripts/preseed-yext.js` — fetch all healthcareFacility entities, save to `data/yext-facilities.json`
- **At startup:** Load into memory, index by care type keyword
- **Tool change:** `baptist_health_location_lookup` searches local data first, falls back to live API only if local data is >30 days old
- **Savings:** Eliminates 1-19 API calls per query (~500ms-10s saved). Most queries become instant.
- **Refresh:** Monthly, or on-demand when a new facility opens

## Priority 2: Yext BH Physicians (HIGH impact, easy)
**Current:** Physician searches hit Yext live API. With city adjacency maps, a single search can make 9 Yext calls.
**Opportunity:** ~7,500 physicians. Data changes (new hires, departures) but not hourly.
- **Script:** `scripts/preseed-yext-physicians.js` — fetch all healthcareProfessional entities
- **Save to:** `data/yext-physicians.json`
- **Savings:** Eliminates 1-9 API calls per physician query
- **Refresh:** Weekly or bi-weekly

## Priority 3: Geocoding Cache (MEDIUM impact, easy)
**Current:** Every location query geocodes an address via Google Maps API ($5/1000 calls).
**Opportunity:** Users ask about the same ~30-50 neighborhoods/cities repeatedly (Doral, Brickell, Coral Gables, etc.)
- **Implementation:** Add a geocode cache in `data/geocode-cache.json` (similar to Census cache pattern)
- **Key:** Normalized address string → `{ lat, lng, formatted_address, timestamp }`
- **TTL:** 1 year (addresses don't move)
- **Savings:** $0.005 per cached hit, eliminates 500ms latency

## Priority 4: Common Isochrone Cache (MEDIUM impact, moderate)
**Current:** Each isochrone call hits OpenRouteService API (~1-2s). Users frequently ask about the same origins with the same drive times.
**Opportunity:** Cache isochrone polygons for common origin+range combinations.
- **Implementation:** Cache in `data/isochrone-cache.json`, keyed by `${lat.toFixed(4)},${lng.toFixed(4)}_${range}`
- **TTL:** 90 days (road networks change slowly)
- **Savings:** Eliminates 1-2s per cached hit
- **Pre-seed:** Generate isochrones for BH hospital locations at 5/10/15/20 min

## Priority 5: Competitor Baseline Snapshots (LOW impact, complex)
**Current:** Google Places Text Search returns real-time results (~500ms, $32/1000 calls).
**Opportunity:** Competitor locations don't move. Ratings change slowly. Could snapshot top competitors per trade area.
- **Limitation:** Google ToS may restrict caching Places results
- **Alternative:** Cache competitor data in the run ledger (SQLite) with 7-day TTL as a query-level cache
- **Savings:** Moderate — only helps for repeat queries about the same area

## Priority 6: Drive Time Matrix Cache (LOW impact, easy)
**Current:** Google Distance Matrix API ($10/1000 elements). Multiple calls per query.
**Opportunity:** Cache origin→destination drive time pairs.
- **Implementation:** SQLite table `drive_times (origin_lat, origin_lng, dest_lat, dest_lng, duration_s, distance_m, cached_at)`
- **TTL:** 30 days
- **Pre-seed:** Compute drive times from each BH hospital to every other BH facility

## Implementation Order
1. Yext Facilities (biggest bang — eliminates most common API calls)
2. Geocoding Cache (simple, high-frequency)
3. Yext Physicians (same pattern as #1)
4. Isochrone Cache (moderate complexity)
5. Drive Time Cache (nice-to-have)
6. Competitor Cache (complex, ToS considerations)

## Estimated Savings
| Scenario | Before | After (all pre-seeds) |
|----------|--------|----------------------|
| Simple location query | 2-3 API calls, ~1.5s | 0 API calls, instant |
| Full competitive analysis | 8-12 API calls, ~$0.30, ~8s | 2-3 API calls (Places only), ~$0.10, ~3s |
| Full marketing plan (6 queries) | 30-50 API calls, ~$2-4 | 10-15 API calls, ~$0.50-1.50 |
