#!/usr/bin/env node
// Live smoke for the MRA web tools. Run with the Firecrawl variable removed to prove
// nothing depends on it:
//   env -u FIRECRAWL_API_KEY node scripts/test-web-tools.js
require('dotenv').config({ override: true });
delete process.env.FIRECRAWL_API_KEY;

const { webSearch, fetchPageFallback, providerOrder } = require('../webTools');

async function jinaRead(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(45000) });
  return res.text();
}

(async () => {
  let failures = 0;
  console.log('FIRECRAWL_API_KEY present:', 'FIRECRAWL_API_KEY' in process.env);
  console.log('provider order:', providerOrder().join(' > '));

  // 1. search
  const q = 'Baptist Health South Florida new urgent care locations 2026';
  const t0 = Date.now();
  try {
    const r = await webSearch(q, { limit: 5 });
    console.log(`\n[search] provider=${r.provider} results=${r.results.length} in ${Date.now() - t0}ms`);
    r.results.forEach((x, i) => console.log(`  ${i + 1}. ${x.title.slice(0, 70)} | ${x.url.slice(0, 70)}\n     ${x.description.slice(0, 110)}`));
    if (r.results.length < 3) { console.log('  FAIL: fewer than 3 results'); failures++; }
  } catch (e) { console.log('[search] FAIL:', e.message); failures++; }

  // 2. read_page primary path (Jina Reader) on a static page
  try {
    const md = await jinaRead('https://baptisthealth.net/services/urgent-care');
    console.log(`\n[read_page/jina] ${md.length} chars ${md.length > 200 ? 'OK' : 'FAIL'}`);
    if (md.length <= 200) failures++;
  } catch (e) { console.log('[read_page/jina] FAIL:', e.message); failures++; }

  // 3. read_page fallback path (Claude web fetch) on a JS-rendered page
  const jsUrl = 'https://www.healthmerch.com/category/sport-water-bottles';
  const t1 = Date.now();
  try {
    const f = await fetchPageFallback(jsUrl);
    console.log(`\n[read_page/fallback] provider=${f.provider} ${f.content.length} chars in ${Date.now() - t1}ms ${f.content.length > 200 ? 'OK' : 'FAIL'}`);
    console.log('  preview:', f.content.slice(0, 160).replace(/\s+/g, ' '));
    if (f.content.length <= 200) failures++;
  } catch (e) { console.log('[read_page/fallback] FAIL:', e.message); failures++; }

  console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
