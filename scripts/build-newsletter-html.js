/**
 * build-newsletter-html.js — Renders Insight Miner HTML from structured JSON data
 * ALL INLINE STYLES — Gmail-safe. No <style> block, no CSS classes, no CSS variables.
 */

// Colors (inlined everywhere — no CSS variables)
const C = {
  green: '#2EA84A', mint: '#7DE69B', black: '#25282A', turquoise: '#59BEC9',
  coral: '#E5554F', yellow: '#FFCD00', darkBlue: '#0D5F78', deepGreen: '#1D4D52',
  medGray: '#999898', darkGray: '#56595A', border: '#E2DFDB', offWhite: '#F5F4F2',
  white: '#ffffff', bg: '#E2DFDB'
};

// BH logo mark — green square with white text (Gmail-safe, no SVG)
const PINEAPPLE_SVG = `<div style="display:inline-block;width:28px;height:28px;background:#2EA84A;border-radius:4px;text-align:center;line-height:28px;font-family:'Poppins',sans-serif;font-size:11px;font-weight:800;color:#ffffff;vertical-align:middle;">BH</div>`;

function renderStory(s) {
  const borderColor = s.type === 'threat' ? C.coral : s.type === 'watch' ? C.yellow : s.type === 'opp' ? C.turquoise : C.green;
  const tagBg = s.tag_color === 'red' ? '#FDECEB' : s.tag_color === 'yellow' ? '#FFF8E1' : s.tag_color === 'blue' ? '#E8F6F8' : '#F0EFED';
  const tagFg = s.tag_color === 'red' ? C.coral : s.tag_color === 'yellow' ? '#B8860B' : s.tag_color === 'blue' ? C.darkBlue : C.darkGray;

  let dots = '';
  if (s.impact_dots) {
    const filled = Array(s.impact_dots).fill(`<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${C.coral};margin-right:3px;"></span>`).join('');
    const empty = Array(Math.max(0, 5 - s.impact_dots)).fill(`<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${C.border};margin-right:3px;"></span>`).join('');
    dots = `<div style="margin-top:12px;"><span style="font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${C.medGray};margin-right:8px;">BH Impact</span>${filled}${empty}</div>`;
  }

  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;"><tr><td style="padding:24px;background:${C.white};border:1px solid ${C.border};border-radius:6px;border-left:4px solid ${borderColor};">
    <span style="font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;display:inline-block;padding:2px 8px;border-radius:3px;margin-bottom:8px;background:${tagBg};color:${tagFg};">${s.tag_text || ''}</span>
    <div style="font-family:'Poppins',sans-serif;font-size:15px;font-weight:700;color:${C.black};margin-bottom:8px;line-height:1.3;">${s.headline || ''}</div>
    <div style="font-size:14px;color:${C.darkGray};line-height:1.65;">${s.body_html || ''}</div>
    ${s.marketing_impact_html ? `<div style="margin-top:14px;padding:14px 16px;background:#f4f9f5;border-radius:5px;border:1px solid #d5edda;">
      <div style="font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${C.green};margin-bottom:6px;">Marketing Impact</div>
      <div style="font-size:12.5px;line-height:1.55;color:${C.darkGray};">${s.marketing_impact_html}</div>
    </div>` : ''}
    ${dots}
    ${s.sources_html ? `<div style="font-size:10px;color:${C.medGray};margin-top:10px;padding-top:8px;border-top:1px solid ${C.border};">Sources: ${s.sources_html}</div>` : ''}
  </td></tr></table>`;
}

function sectionHeader(num, tag, title, dark) {
  const numBg = dark ? C.green : C.black;
  const tagColor = dark ? 'rgba(255,255,255,0.4)' : C.medGray;
  const titleColor = dark ? C.white : C.black;
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="24" style="vertical-align:middle;"><div style="font-family:'Poppins',sans-serif;font-size:10px;font-weight:700;color:${C.white};background:${numBg};width:24px;height:24px;line-height:24px;text-align:center;border-radius:5px;">${num}</div></td>
    <td style="vertical-align:middle;padding-left:10px;"><span style="font-family:'Poppins',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${tagColor};">${tag}</span></td>
  </tr></table>
  <div style="font-family:'Poppins',sans-serif;font-size:23px;font-weight:800;color:${titleColor};line-height:1.2;margin-top:6px;margin-bottom:14px;">${title}</div>`;
}

function buildNewsletterHtml(data) {
  const d = data;
  const s = d.sections || {};

  const execBullets = (d.exec_summary || []).map(b =>
    `<tr><td width="20" style="vertical-align:top;color:${C.green};font-weight:700;font-size:15px;line-height:1.5;">&rsaquo;</td><td style="font-size:13px;color:rgba(255,255,255,0.7);line-height:1.55;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.06);">${b}</td></tr>`
  ).join('');

  const stats = (d.stats || []).map((s, i) =>
    `<td width="25%" style="padding:20px;text-align:center;${i < 3 ? 'border-right:1px solid rgba(255,255,255,0.06);' : ''}">
      <div style="font-family:'Poppins',sans-serif;font-size:24px;font-weight:800;color:${C.white};">${s.num}</div>
      <div style="font-size:9px;font-weight:500;color:rgba(255,255,255,0.4);margin-top:3px;line-height:1.3;">${s.label}</div>
    </td>`
  ).join('');

  // S1
  const s1 = (s.s1_psa_news?.stories || []).map(st => renderStory(st)).join('');

  // S2
  const s2 = s.s2_competitive || {};
  const capex = (s2.capex_chart || []).map(c =>
    `<tr><td width="110" style="font-size:11px;font-weight:600;color:${C.black};text-align:right;padding:4px 0;">${c.label}</td>
     <td style="padding:4px 10px;"><div style="background:#E8E6E3;border-radius:3px;height:20px;"><div style="background:${c.color || C.coral};height:20px;width:${c.width_pct}%;border-radius:3px;"></div></div></td>
     <td width="55" style="font-family:'Poppins',sans-serif;font-size:12px;font-weight:700;color:${C.black};">${c.value}</td></tr>`
  ).join('');
  const s2Stories = (s2.stories || []).map(st => renderStory(st)).join('');
  const stewardRows = (s2.steward_hospitals || []).map(h =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};font-weight:700;">${h.name}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};">${h.location}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};">${h.county}</td></tr>`
  ).join('');

  // S3
  const s3 = s.s3_ai_tech || {};
  const s3Stories = (s3.stories || []).map(st => renderStory(st)).join('');

  // S4 permits
  const s4 = s.s4_permits || {};
  const permitRows = (s4.permits_table || []).map((p, i) => {
    let badge = '';
    if (p.delta === 'NEW') badge = `<span style="display:inline-block;font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;padding:2px 7px;border-radius:3px;background:#E8F5E9;color:#2E7D32;margin-left:4px;">NEW</span>`;
    else if (p.delta === 'UPDATED') badge = `<span style="display:inline-block;font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;padding:2px 7px;border-radius:3px;background:#E3F2FD;color:#1565C0;margin-left:4px;">UPDATED</span>`;
    const bg = i % 2 === 1 ? `background:${C.offWhite};` : '';
    return `<tr><td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};font-weight:700;${bg}">${p.project}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};${bg}">${p.system || ''}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};${bg}">${p.county || ''}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};${bg}">${p.value || 'TBD'}</td>
     <td style="padding:10px 12px;border-bottom:1px solid ${C.border};color:${C.darkGray};${bg}">${p.status || ''} ${badge}</td></tr>`;
  }).join('');

  // S5 M&A
  const s5 = s.s5_ma || {};
  const s5Stories = (s5.stories || []).map(st => renderStory(st)).join('');

  // S6 Policy
  const s6 = s.s6_policy || {};
  const metricCards = (s6.metric_cards || []).map(c => {
    const topColor = c.color === 'red' ? C.coral : c.color === 'yellow' ? C.yellow : C.green;
    return `<td width="48%" style="background:${C.white};border:1px solid ${C.border};border-radius:6px;border-top:3px solid ${topColor};padding:20px;vertical-align:top;">
      <div style="font-family:'Poppins',sans-serif;font-size:24px;font-weight:800;color:${C.black};line-height:1.1;">${c.num}</div>
      <div style="font-size:11.5px;color:${C.darkGray};margin-top:4px;line-height:1.4;">${c.description}</div>
    </td>`;
  });
  let metricHtml = '';
  for (let i = 0; i < metricCards.length; i += 2) {
    metricHtml += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0;"><tr>${metricCards[i]}${metricCards[i+1] ? '<td width="4%"></td>' + metricCards[i+1] : ''}</tr></table>`;
  }
  const s6Stories = (s6.stories || []).map(st => renderStory(st)).join('');

  // S7 Insights
  const insights = (s.s7_insights?.insights || []).map((ins, i) =>
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:18px 0;border-bottom:1px solid ${C.border};"><tr>
      <td width="34" style="vertical-align:top;"><div style="font-family:'Poppins',sans-serif;font-size:13px;font-weight:800;color:${C.white};background:${C.black};width:34px;height:34px;line-height:34px;text-align:center;border-radius:6px;">${i + 1}</div></td>
      <td style="vertical-align:top;padding-left:16px;">
        <div style="font-family:'Poppins',sans-serif;font-size:13.5px;font-weight:700;color:${C.black};margin-bottom:4px;line-height:1.3;">${ins.headline}</div>
        <div style="font-size:12.5px;color:${C.darkGray};line-height:1.55;">${ins.body}</div>
      </td>
    </tr></table>`
  ).join('');

  // Callout helper
  const callout = (title, html, dark) => {
    if (!html) return '';
    const bg = dark ? 'rgba(255,255,255,0.06)' : C.black;
    const border = dark ? '1px solid rgba(255,255,255,0.08)' : 'none';
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;"><tr><td style="padding:20px 22px;background:${bg};border-radius:6px;${border ? 'border:' + border + ';' : ''}">
      <div style="font-family:'Poppins',sans-serif;font-size:12px;font-weight:700;color:${C.mint};margin-bottom:6px;">${title}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.7);line-height:1.55;">${html}</div>
    </td></tr></table>`;
  };

  const thStyle = `font-family:'Poppins',sans-serif;font-size:8.5px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${C.white};background:${C.black};text-align:left;padding:10px 12px;`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head><body style="margin:0;padding:0;font-family:'Inter',Helvetica,Arial,sans-serif;background:${C.bg};color:${C.black};line-height:1.65;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:32px 0;">
<table width="780" cellpadding="0" cellspacing="0" border="0" style="background:${C.white};box-shadow:0 4px 40px rgba(0,0,0,0.12);">

<!-- MASTHEAD -->
<tr><td style="background:${C.black};padding:14px 40px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td>${PINEAPPLE_SVG} <span style="font-family:'Poppins',sans-serif;font-weight:800;font-size:14px;letter-spacing:0.2em;color:${C.white};vertical-align:middle;margin-left:12px;">INSIGHT MINER</span></td>
    <td style="text-align:right;"><div style="font-family:'Poppins',sans-serif;font-weight:700;font-size:8.5px;letter-spacing:0.12em;color:${C.green};">${d.vol_issue || 'VOL. 1'}</div><div style="font-size:9px;color:${C.medGray};">Baptist Health South Florida</div></td>
  </tr></table>
</td></tr>

<!-- GREEN RULE -->
<tr><td style="height:3px;background:${C.green};font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- HERO -->
<tr><td style="background:${C.white};padding:40px 40px 20px;">
  <div style="font-family:'Poppins',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${C.green};margin-bottom:14px;">Bi-Weekly Market Intelligence &mdash; ${d.issue_date_range || ''}</div>
  <div style="font-family:'Poppins',sans-serif;font-size:28px;font-weight:800;color:${C.black};line-height:1.15;">${d.hero_headline || ''}</div>
</td></tr>

<!-- EXEC SUMMARY -->
<tr><td style="padding:0 40px 36px;background:${C.white};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.black};border-radius:8px;"><tr><td style="padding:26px 28px;">
    <div style="font-family:'Poppins',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${C.mint};margin-bottom:14px;">Executive Summary</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${execBullets}</table>
  </td></tr></table>
</td></tr>

<!-- STATS -->
<tr><td style="background:${C.black};"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${stats}</tr></table></td></tr>

<!-- S1 PSA NEWS -->
<tr><td style="padding:44px 40px 40px;background:${C.white};border-bottom:1px solid ${C.border};">
  ${sectionHeader(1, 'Primary Service Area News', s.s1_psa_news?.subtitle || 'Market-Moving Stories From Our Four Counties')}
  ${s1}
</td></tr>

<!-- S2 COMPETITIVE -->
<tr><td style="padding:44px 40px 40px;background:${C.offWhite};border-bottom:1px solid ${C.border};">
  ${sectionHeader(2, 'Competitive Intelligence', s2.subtitle || "Who's Building, Buying, and Positioning Against Us")}
  ${capex ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.offWhite};border:1px solid ${C.border};border-radius:6px;padding:22px;margin:18px 0;">
    <tr><td style="padding:22px;"><div style="font-family:'Poppins',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${C.darkGray};margin-bottom:16px;">Competitor Capital Investment &mdash; Active Projects</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${capex}</table></td></tr></table>` : ''}
  ${s2Stories}
  ${stewardRows ? `<div style="font-family:'Poppins',sans-serif;font-size:16px;font-weight:700;color:${C.black};margin:32px 0 10px;">Steward Watch</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="${thStyle}">Hospital</td><td style="${thStyle}">Location</td><td style="${thStyle}">County</td></tr>${stewardRows}</table>
    ${s2.steward_marketing_impact_html ? `<div style="margin-top:14px;padding:14px 16px;background:#f4f9f5;border-radius:5px;border:1px solid #d5edda;"><div style="font-family:'Poppins',sans-serif;font-size:8px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${C.green};margin-bottom:6px;">Marketing Impact</div><div style="font-size:12.5px;line-height:1.55;color:${C.darkGray};">${s2.steward_marketing_impact_html}</div></div>` : ''}` : ''}
</td></tr>

<!-- GREEN DIVIDER -->
<tr><td style="height:3px;background:${C.green};font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- S3 AI -->
<tr><td style="padding:44px 40px 40px;background:${C.white};border-bottom:1px solid ${C.border};">
  ${sectionHeader(3, 'AI &amp; Marketing Technology', s3.subtitle || "What's Moving in AI")}
  ${s3Stories}
  ${s3.bottom_line_html ? callout('The Bottom Line on AI', s3.bottom_line_html) : ''}
</td></tr>

<!-- S4 PERMITS -->
<tr><td style="padding:44px 40px 40px;background:${C.offWhite};border-bottom:1px solid ${C.border};">
  ${sectionHeader(4, 'Permit &amp; Construction Tracker', s4.subtitle || "What's Being Built in Our Four Counties")}
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;">
    <tr><td style="${thStyle}">Project</td><td style="${thStyle}">System</td><td style="${thStyle}">County</td><td style="${thStyle}">Value</td><td style="${thStyle}">Status</td></tr>
    ${permitRows}
  </table>
</td></tr>

<!-- S5 M&A (DARK) -->
<tr><td style="padding:44px 40px 40px;background:${C.black};">
  ${sectionHeader(5, 'Mergers &amp; Acquisitions Watch', s5.subtitle || 'Deals, Acquisitions, and the Private Equity Playbook', true)}
  <div style="font-size:14px;color:rgba(255,255,255,0.65);margin-bottom:16px;">${s5.deal_count_headline || ''}</div>
  ${s5Stories}
  ${s5.callout_html ? callout('The Private Equity Signal for Marketing', s5.callout_html, true) : ''}
</td></tr>

<!-- S6 POLICY -->
<tr><td style="padding:44px 40px 40px;background:${C.white};border-bottom:1px solid ${C.border};">
  ${sectionHeader(6, 'Policy &amp; Macro', s6.subtitle || 'Policy Shifts Reshaping Our Patient Base')}
  ${metricHtml}
  ${s6Stories}
</td></tr>

<!-- GREEN DIVIDER -->
<tr><td style="height:3px;background:${C.green};font-size:0;line-height:0;">&nbsp;</td></tr>

<!-- S7 INSIGHTS -->
<tr><td style="padding:44px 40px 40px;background:${C.offWhite};">
  ${sectionHeader(7, 'Insights to Think About', 'Questions for the Marketing Leadership Team')}
  ${insights}
</td></tr>

<!-- FOOTER -->
<tr><td style="background:${C.black};padding:32px 40px;text-align:center;">
  <div style="font-family:'Poppins',sans-serif;font-weight:800;font-size:12px;letter-spacing:0.2em;color:${C.white};margin-bottom:2px;">INSIGHT MINER</div>
  <div style="font-size:9px;color:${C.medGray};margin-bottom:16px;">Powered by the MarCom Market Research Agent &middot; Baptist Health South Florida</div>
  <div style="display:inline-block;font-family:'Poppins',sans-serif;font-size:7.5px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${C.mint};border:1px solid rgba(125,230,155,0.2);border-radius:3px;padding:4px 12px;">Generated by AI &mdash; Verified by Humans</div>
</td></tr>

</table></td></tr></table></body></html>`;
}

module.exports = { buildNewsletterHtml };
