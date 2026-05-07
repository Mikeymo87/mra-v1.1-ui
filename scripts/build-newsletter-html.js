/**
 * build-newsletter-html.js — Renders Insight Miner HTML from structured JSON data
 *
 * Uses the exact CSS and design from the hand-built prototype (insight-miner.html).
 * The agent provides content as JSON; this function provides the design.
 */

const fs = require('fs');
const path = require('path');

// Load CSS from the prototype template
function loadTemplateCSS() {
  const templatePath = path.join(__dirname, '..', '..', 'MRA-Newsletter', 'insight-miner.html');
  const html = fs.readFileSync(templatePath, 'utf-8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  return styleMatch ? styleMatch[1] : '';
}

// Pineapple SVG (from prototype)
const PINEAPPLE_SVG = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg"><rect fill="#2ea84a" width="160" height="160"/><path fill="#fff" d="M80,51.52c-5.97-12.84-18.98-21.74-34.08-21.74-5.34,0-10.42,1.11-15.01,3.12.89-.07,1.79-.11,2.69-.11,13.24,0,24.69,7.62,30.22,18.72h16.18Z"/><path fill="#fff" d="M126.4,32.79c.91,0,1.81.04,2.69.11-4.6-2.01-9.68-3.12-15.01-3.12-15.09,0-28.11,8.9-34.08,21.74h0s16.18,0,16.18,0c5.52-11.1,16.98-18.72,30.22-18.72Z"/><path fill="#fff" d="M107.04,21.15c-1.15-.34-2.33-.6-3.54-.78-.58-.09-1.17-.16-1.76-.2-.72-.06-1.46-.09-2.2-.09-.99,0-1.97.05-2.93.16-6.55.72-12.38,3.82-16.61,8.42-4.23-4.6-10.06-7.7-16.61-8.42-.96-.11-1.94-.16-2.93-.16-.74,0-1.47.03-2.2.09-.59.05-1.18.12-1.76.2-1.21.18-2.39.44-3.54.78-1.14.33-2.25.75-3.32,1.22.44.04.89.09,1.33.14,13.03,1.65,23.64,9.78,29.03,20.74,5.38-10.96,16-19.09,29.03-20.74.45-.06.89-.1,1.33-.14-1.07-.48-2.18-.89-3.32-1.22Z"/><path fill="#fff" d="M80,22.43c4.16-4.58,9.89-7.67,16.33-8.39.95-.11,1.91-.16,2.88-.16.44,0,.88.01,1.32.03-1.82-.76-3.73-1.29-5.7-1.56-.99-.13-1.99-.2-3.01-.2-.76,0-1.51.04-2.25.11-.61.06-1.21.15-1.81.26-1.24.23-2.45.56-3.64.99-3.05,1.11-5.88,2.86-8.39,5.13,1.55,1.1,2.98,2.37,4.26,3.77Z"/><polygon fill="#fff" points="85.08 112.17 73.02 102.44 82.74 90.38 94.8 100.1 85.08 112.17"/><polygon fill="#fff" points="76.32 133.19 86.04 121.13 98.11 130.85 88.38 142.91 76.32 133.19"/><polygon fill="#fff" points="91.5 69.36 81.78 81.42 69.71 71.7 79.44 59.63 91.5 69.36"/><polygon fill="#fff" points="111.83 113.83 102.1 125.89 90.04 116.17 99.76 104.1 111.83 113.83"/><path fill="#fff" d="M51.03,84.72l-7.13-5.75c1.9-5.14,4.45-9.81,7.51-13.85l9.34,7.53-9.72,12.06Z"/><polygon fill="#fff" points="77.78 86.38 68.05 98.45 55.99 88.72 65.71 76.66 77.78 86.38"/><polygon fill="#fff" points="42.27 105.75 51.99 93.68 64.06 103.41 54.33 115.47 42.27 105.75"/><path fill="#fff" d="M72.32,138.15l11.86,9.56c-1.27.09-2.57.13-3.9.13-5.25,0-9.97-.69-14.16-2l6.2-7.7Z"/><path fill="#fff" d="M41.89,85.54l5.14,4.14-6.9,8.56c.17-4.4.78-8.66,1.77-12.71Z"/><polygon fill="#fff" points="81.08 117.13 71.36 129.19 59.29 119.47 69.02 107.41 81.08 117.13"/><path fill="#fff" d="M107.06,129.89l9.72-12.06,1.55,1.25c-1.46,5.56-3.67,10.45-6.65,14.54l-4.62-3.73Z"/><path fill="#fff" d="M119.92,92.26c.37,2.79.56,5.65.56,8.57,0,.77,0,1.54-.03,2.29l-4.62,5.74-12.06-9.72,9.72-12.06,6.43,5.19Z"/><path fill="#fff" d="M103.07,134.85l4.4,3.55c-3.65,3.4-8.09,5.96-13.34,7.55l8.94-11.1Z"/><path fill="#fff" d="M48.41,132.97l6.89-8.54,12.06,9.72-7.37,9.15c-4.71-2.51-8.56-5.99-11.58-10.33Z"/><path fill="#fff" d="M112.52,78.12l-12.06-9.72,5.59-6.94c3.57,3.81,6.61,8.4,8.97,13.56l-2.5,3.1Z"/><path fill="#fff" d="M50.33,120.43l-5.31,6.59c-1.93-4.2-3.29-8.94-4.08-14.16l9.39,7.57Z"/><polygon fill="#fff" points="98.8 95.14 86.74 85.42 96.46 73.36 108.53 83.08 98.8 95.14"/><path fill="#fff" d="M55.61,60.33c1.28-1.27,2.62-2.45,4.02-3.52h13.91l-8.78,10.89-9.15-7.37Z"/><path fill="#fff" d="M101.35,57.14l-5.85,7.26-9.42-7.59h14.85c.14.11.28.22.42.33Z"/></svg>`;

// ── Helper: render a story card ─────────────────────────────────────────────
function renderStory(s, isDark = false) {
  const typeClass = s.type === 'threat' ? ' threat' : s.type === 'watch' ? ' watch' : s.type === 'opp' ? ' opp' : '';
  const tagClass = s.tag_color === 'red' ? 't-red' : s.tag_color === 'yellow' ? 't-yellow' : s.tag_color === 'blue' ? 't-blue' : 't-gray';

  let dots = '';
  if (s.impact_dots) {
    const filled = Array(s.impact_dots).fill('<span class="d on"></span>').join('');
    const empty = Array(Math.max(0, 5 - s.impact_dots)).fill('<span class="d"></span>').join('');
    dots = `<div class="dots-row"><span class="dots-label">BH Impact</span><div class="dots">${filled}${empty}</div></div>`;
  }

  return `
    <div class="story${typeClass}">
      <span class="tag ${tagClass}">${s.tag_text || ''}</span>
      <h4>${s.headline || ''}</h4>
      ${s.body_html || ''}
      ${s.marketing_impact_html ? `<div class="mi"><div class="mi-label">Marketing Impact</div>${s.marketing_impact_html}</div>` : ''}
      ${dots}
      ${s.sources_html ? `<p class="src">Sources: ${s.sources_html}</p>` : ''}
    </div>`;
}

// ── Helper: render impact dots ──────────────────────────────────────────────
function renderDots(n) {
  const filled = Array(n).fill('<span class="d on"></span>').join('');
  const empty = Array(Math.max(0, 5 - n)).fill('<span class="d"></span>').join('');
  return `<div class="dots-row"><span class="dots-label">BH Impact</span><div class="dots">${filled}${empty}</div></div>`;
}

// ── Main builder ────────────────────────────────────────────────────────────
function buildNewsletterHtml(data, dateStart, dateEnd) {
  const css = loadTemplateCSS();
  const d = data;
  const s = d.sections || {};

  // Exec summary bullets
  const execBullets = (d.exec_summary || []).map(b =>
    `<li><span class="exec-bullet">&rsaquo;</span> <span>${b}</span></li>`
  ).join('\n        ');

  // Stats strip
  const statsHtml = (d.stats || []).map(s =>
    `<div class="stat"><div class="num">${s.num}</div><div class="lbl">${s.label}</div></div>`
  ).join('\n    ');

  // Section 1: PSA News
  const s1Stories = (s.s1_psa_news?.stories || []).map(st => renderStory(st)).join('\n');

  // Section 2: Competitive Intel
  const s2 = s.s2_competitive || {};
  const capexBars = (s2.capex_chart || []).map(c =>
    `<div class="bar-row"><div class="bar-label">${c.label}</div><div class="bar-track"><div class="bar-fill" style="width:${c.width_pct}%;background:${c.color || 'var(--coral)'};"></div></div><div class="bar-val">${c.value}</div></div>`
  ).join('\n      ');
  const s2Stories = (s2.stories || []).map(st => renderStory(st)).join('\n');
  const fsedCards = (s2.fsed_cards || []).map(c =>
    `<div class="mc ${c.color || ''}"><div class="num" style="font-size:17px;">${c.system}</div><div class="desc">${c.description}</div></div>`
  ).join('\n      ');
  const stewardRows = (s2.steward_hospitals || []).map(h =>
    `<tr><td><strong>${h.name}</strong></td><td>${h.location}</td><td>${h.county}</td></tr>`
  ).join('\n        ');
  const s2StewardMI = s2.steward_marketing_impact_html || '';

  // Section 3: AI & Marketing Tech
  const s3 = s.s3_ai_tech || {};
  const s3Stories = (s3.stories || []).map(st => renderStory(st)).join('\n');
  const s3BottomLine = s3.bottom_line_html || '';

  // Section 4: Permits
  const s4 = s.s4_permits || {};
  const permitRows = (s4.permits_table || []).map(p => {
    let deltaBadge = '';
    if (p.delta === 'NEW') deltaBadge = '<span class="bdg bdg-g">NEW</span>';
    else if (p.delta === 'UPDATED') deltaBadge = '<span class="bdg bdg-b">UPDATED</span>';
    const projectLink = p.source_url ? `<a href="${p.source_url}" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--medium-gray);">${p.project}</a>` : p.project;
    return `<tr><td><strong>${projectLink}</strong></td><td>${p.system || ''}</td><td>${p.county || ''}</td><td>${p.value || 'TBD'}</td><td>${p.status || ''} ${deltaBadge}</td></tr>`;
  }).join('\n        ');

  // Section 5: M&A (dark section)
  const s5 = s.s5_ma || {};
  const s5Stories = (s5.stories || []).map(st => renderStory(st, true)).join('\n');
  const s5Callout = s5.callout_html || '';
  const s5DealChart = s5.deal_chart || [];
  const dealBars = s5DealChart.map(b =>
    `<div style="flex:1;text-align:center;"><div style="background:${b.highlight ? 'var(--green)' : 'rgba(255,255,255,0.06)'};height:${b.height || 60}px;border-radius:3px 3px 0 0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:5px;"><span style="font-family:'Poppins';font-size:${b.highlight ? '14' : '11'}px;color:${b.highlight ? '#fff' : 'rgba(255,255,255,0.35)'};font-weight:${b.highlight ? 800 : 700};">${b.value}</span></div><div style="font-size:9px;color:${b.highlight ? 'var(--mint)' : 'rgba(255,255,255,0.3)'};margin-top:5px;${b.highlight ? 'font-weight:600;' : ''}">${b.label}</div></div>`
  ).join('\n        ');

  // Section 6: Policy
  const s6 = s.s6_policy || {};
  const metricCards = (s6.metric_cards || []).map(c =>
    `<div class="mc ${c.color || ''}""><div class="num">${c.num}</div><div class="desc">${c.description}</div></div>`
  ).join('\n      ');
  const s6Stories = (s6.stories || []).map(st => renderStory(st)).join('\n');

  // Section 7: Insights
  const s7 = s.s7_insights || {};
  const insights = (s7.insights || []).map((ins, i) =>
    `<div class="insight"><div class="i-num">${i + 1}</div><div><h4>${ins.headline}</h4><p>${ins.body}</p></div></div>`
  ).join('\n\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Insight Miner &mdash; ${d.issue_date_range || ''}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>

<div class="container">

  <!-- MASTHEAD -->
  <div class="masthead">
    <div class="mast-left">
      <div class="pineapple">${PINEAPPLE_SVG}</div>
      <div class="mast-name">INSIGHT MINER</div>
    </div>
    <div class="mast-right">
      <div class="vol">${d.vol_issue || 'VOL. 1 &mdash; ISSUE 02'}</div>
      Baptist Health South Florida
    </div>
  </div>
  <div class="brand-rule"></div>

  <!-- HERO -->
  <div class="hero">
    <div class="hero-eyebrow">Bi-Weekly Market Intelligence &mdash; ${d.issue_date_range || ''}</div>
    <h1>${d.hero_headline || ''}</h1>
  </div>

  <!-- EXEC SUMMARY -->
  <div class="exec-wrap">
    <div class="exec-box">
      <div class="exec-label">Executive Summary</div>
      <ul class="exec-list">
        ${execBullets}
      </ul>
    </div>
  </div>

  <!-- STATS -->
  <div class="stats">
    ${statsHtml}
  </div>

  <!-- TOC -->
  <div class="toc">
    <span class="toc-label">In This Issue</span>
    <a href="#s1">Primary Service Area News</a>
    <a href="#s2">Competitive Intel</a>
    <a href="#s3">AI &amp; Marketing Tech</a>
    <a href="#s4">Permits</a>
    <a href="#s5">Mergers &amp; Acquisitions</a>
    <a href="#s6">Policy</a>
    <a href="#s7">Insights</a>
  </div>

  <!-- S1: PSA NEWS -->
  <div class="section" id="s1">
    <div class="sec-head"><div class="sec-num">1</div><span class="sec-tag">Primary Service Area News</span></div>
    <h2>${s.s1_psa_news?.subtitle || 'Market-Moving Stories From Our Four Counties'}</h2>
    ${s1Stories}
  </div>

  <!-- S2: COMPETITIVE INTELLIGENCE -->
  <div class="section alt" id="s2">
    <div class="sec-head"><div class="sec-num">2</div><span class="sec-tag">Competitive Intelligence</span></div>
    <h2>${s2.subtitle || "Who's Building, Buying, and Positioning Against Us"}</h2>

    ${capexBars ? `<div class="chart">
      <div class="chart-title">Competitor Capital Investment in the Primary Service Area &mdash; Active Projects</div>
      ${capexBars}
    </div>` : ''}

    ${s2Stories}

    ${fsedCards ? `<div class="metrics">${fsedCards}</div>` : ''}

    ${stewardRows ? `
    <h3>Steward Watch</h3>
    <table>
      <thead><tr><th>Hospital</th><th>Location</th><th>County</th></tr></thead>
      <tbody>${stewardRows}</tbody>
    </table>
    ${s2StewardMI ? `<div class="mi"><div class="mi-label">Marketing Impact</div>${s2StewardMI}</div>` : ''}
    ` : ''}
  </div>

  <div class="sep"></div>

  <!-- S3: AI & MARKETING TECH -->
  <div class="section" id="s3">
    <div class="sec-head"><div class="sec-num">3</div><span class="sec-tag">AI &amp; Marketing Technology</span></div>
    <h2>${s3.subtitle || "What's Moving in AI &mdash; and What We Should Do About It"}</h2>
    ${s3Stories}
    ${s3BottomLine ? `<div class="callout"><div class="cl">The Bottom Line on AI</div>${s3BottomLine}</div>` : ''}
  </div>

  <!-- S4: PERMITS -->
  <div class="section alt" id="s4">
    <div class="sec-head"><div class="sec-num">4</div><span class="sec-tag">Permit &amp; Construction Tracker</span></div>
    <h2>${s4.subtitle || "What's Being Built in Our Four Counties"}</h2>
    <p class="sec-intro">Active healthcare construction, Florida Agency for Health Care Administration filings, and facility approvals across the Primary Service Area.</p>
    <table>
      <thead><tr><th>Project</th><th>System</th><th>County</th><th>Value</th><th>Status</th></tr></thead>
      <tbody>
        ${permitRows}
      </tbody>
    </table>
  </div>

  <!-- S5: M&A (dark) -->
  <div class="section-dark" id="s5">
    <div class="sec-head"><div class="sec-num">5</div><span class="sec-tag">Mergers &amp; Acquisitions Watch</span></div>
    <h2>${s5.subtitle || 'Deals, Acquisitions, and the Private Equity Playbook'}</h2>
    <p>${s5.deal_count_headline || ''}</p>

    ${dealBars ? `<div class="chart">
      <div class="chart-title" style="color:rgba(255,255,255,0.45);">Hospital Mergers &amp; Acquisitions &mdash; Year Over Year</div>
      <div style="display:flex;align-items:flex-end;gap:20px;height:130px;">
        ${dealBars}
      </div>
    </div>` : ''}

    ${s5Stories}

    ${s5Callout ? `<div class="callout"><div class="cl">The Private Equity Signal for Marketing</div>${s5Callout}</div>` : ''}
  </div>

  <!-- S6: POLICY -->
  <div class="section" id="s6">
    <div class="sec-head"><div class="sec-num">6</div><span class="sec-tag">Policy &amp; Macro</span></div>
    <h2>${s6.subtitle || 'Policy Shifts Reshaping Our Patient Base'}</h2>
    ${metricCards ? `<div class="metrics">${metricCards}</div>` : ''}
    ${s6Stories}
  </div>

  <div class="sep"></div>

  <!-- S7: INSIGHTS -->
  <div class="section alt" id="s7">
    <div class="sec-head"><div class="sec-num">7</div><span class="sec-tag">Insights to Think About</span></div>
    <h2>Questions for the Marketing Leadership Team</h2>
    ${insights}
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="f-logo">INSIGHT MINER</div>
    <div class="f-sub">Powered by the MarCom Market Research Agent &middot; Baptist Health South Florida</div>
    <div class="f-badge">Generated by AI &mdash; Verified by Humans</div>
  </div>

</div>
</body>
</html>`;
}

module.exports = { buildNewsletterHtml };
