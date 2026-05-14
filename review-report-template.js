// review-report-template.js — Generates branded HTML review report
// Matches the BH Urgent Care Brickell template design exactly

function generateReviewReportHTML(data) {
  const {
    location_name, address, total_reviews_analyzed, total_reviews_available,
    avg_rating, rating_distribution, date_range, response_rate,
    mentioned_names, top_themes, sentiment_breakdown, reviews
  } = data;

  // Compute percentages
  const total = total_reviews_analyzed;
  const pctPositive = total > 0 ? ((sentiment_breakdown.positive / total) * 100).toFixed(1) : '0';
  const pctNegative = total > 0 ? ((sentiment_breakdown.negative / total) * 100).toFixed(1) : '0';
  const pctNeutral = total > 0 ? ((sentiment_breakdown.neutral / total) * 100).toFixed(1) : '0';

  // Rating distribution percentages
  const rdPcts = {};
  for (const [star, count] of Object.entries(rating_distribution)) {
    rdPcts[star] = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
  }

  // Extract location tag (e.g. "Brickell" from "Baptist Health Urgent Care | Brickell")
  const pipeSplit = location_name.split('|');
  const locationTag = pipeSplit.length > 1 ? pipeSplit[pipeSplit.length - 1].trim() : '';
  const mainName = pipeSplit[0].trim();

  // Top positive and negative quotes
  const positiveQuotes = (reviews || [])
    .filter(r => (r.rating?.value || r.rating) >= 4 && (r.review_text || r.text || '').length > 50)
    .slice(0, 5)
    .map(r => ({ text: (r.review_text || r.text || '').substring(0, 200), author: r.profile_name || r.author || 'Anonymous', rating: r.rating?.value || r.rating }));

  const negativeQuotes = (reviews || [])
    .filter(r => (r.rating?.value || r.rating) <= 2 && (r.review_text || r.text || '').length > 50)
    .slice(0, 5)
    .map(r => ({ text: (r.review_text || r.text || '').substring(0, 300), author: r.profile_name || r.author || 'Anonymous', rating: r.rating?.value || r.rating }));

  // Determine risk themes (negative > positive)
  const riskThemes = (top_themes || []).filter(t => t.negative_mentions > t.positive_mentions);

  // Staff cards HTML
  const staffCardsHTML = (mentioned_names || []).slice(0, 12).map(n => {
    const role = /^Dr\./.test(n.name) ? 'Physician' : /nurse|rn|np/i.test(n.name) ? 'Nurse' : 'PA';
    const sentColor = n.sentiment === 'positive' ? '#2EA84A' : n.sentiment === 'negative' ? '#e74c3c' : '#F59E0B';
    const sentText = n.negative_mentions > 0
      ? `${n.count} mentions (${n.positive_mentions} pos / ${n.negative_mentions} neg)`
      : `${n.count} mentions (positive)`;
    return `<div class="staff-card">
      <div class="staff-name">${n.name}</div>
      <div class="staff-role">${role}</div>
      <div class="staff-mentions" style="color:${sentColor}">${sentText}</div>
    </div>`;
  }).join('');

  // Theme bars HTML
  const themeBarsHTML = (top_themes || []).map(t => {
    const totalMentions = t.positive_mentions + t.negative_mentions;
    const posPct = totalMentions > 0 ? (t.positive_mentions / totalMentions) * 100 : 50;
    const isRisk = t.negative_mentions > t.positive_mentions;
    return `<div class="theme-row">
      <div class="theme-info">
        <span class="theme-name">${t.theme}${isRisk ? ' <span class="risk-badge">Risk</span>' : ''}</span>
        <span class="theme-count">${t.mentions} mentions</span>
      </div>
      <div class="theme-bar-container">
        <div class="theme-bar-pos" style="width:${posPct}%"></div>
        <div class="theme-bar-neg" style="width:${100 - posPct}%"></div>
      </div>
      <div class="theme-counts">
        <span class="pos-count">${t.positive_mentions} pos</span>
        <span class="neg-count">${t.negative_mentions} neg</span>
      </div>
    </div>`;
  }).join('');

  // Positive drivers HTML
  const positiveDriversHTML = positiveQuotes.map(q =>
    `<div class="driver-card green-border">
      <p>${q.text}${q.text.length >= 200 ? '...' : ''}</p>
      <span class="driver-author">- ${q.author}</span>
    </div>`
  ).join('');

  // Negative drivers HTML
  const negativeDriversHTML = negativeQuotes.map((q, i) => {
    if (i === 0 && riskThemes.length > 0) {
      return `<div class="risk-callout">
        <div class="risk-label">REPUTATIONAL RISK - ${riskThemes[0].theme.toUpperCase()}</div>
        <p>${q.text}${q.text.length >= 300 ? '...' : ''}</p>
        <span class="driver-author">- ${q.author}</span>
      </div>`;
    }
    return `<div class="driver-card red-border">
      <p>${q.text}${q.text.length >= 300 ? '...' : ''}</p>
      <span class="driver-author">- ${q.author}</span>
    </div>`;
  }).join('');

  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Google Reviews Report - ${location_name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', sans-serif; background: #fff; color: #1a1a1a; line-height: 1.5; }

  .page { max-width: 850px; margin: 0 auto; padding: 0; }

  /* Header */
  .header {
    background: #1a1a1a;
    color: #fff;
    padding: 32px 40px;
    border-radius: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .header-left { flex: 1; }
  .header-label { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #2EA84A; font-weight: 700; margin-bottom: 8px; }
  .header-title { font-size: 28px; font-weight: 800; margin-bottom: 6px; }
  .header-title .tag { background: #333; padding: 4px 12px; border-radius: 4px; font-size: 22px; font-weight: 600; margin-left: 8px; }
  .header-address { font-size: 13px; color: #999; }
  .header-rating { text-align: right; }
  .header-rating .big-number { font-size: 56px; font-weight: 900; color: #2EA84A; line-height: 1; }
  .header-rating .out-of { font-size: 13px; color: #999; }

  /* Stats bar */
  .stats-bar {
    display: flex;
    gap: 0;
    background: #f5f5f5;
    border-bottom: 1px solid #e0e0e0;
    padding: 12px 40px;
  }
  .stat-item { flex: 1; }
  .stat-label { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #888; font-weight: 600; }
  .stat-value { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .stat-value.green { color: #2EA84A; }
  .stat-value.red { color: #e74c3c; }

  /* Content sections */
  .content { padding: 32px 40px; }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 20px; font-weight: 800; margin-bottom: 16px; }

  /* Two-column layout */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }

  /* Rating distribution */
  .rating-bars { display: flex; flex-direction: column; gap: 6px; }
  .rating-row { display: flex; align-items: center; gap: 8px; }
  .rating-label { width: 40px; font-size: 12px; font-weight: 600; text-align: right; }
  .rating-bar-bg { flex: 1; height: 22px; background: #f0f0f0; border-radius: 4px; overflow: hidden; }
  .rating-bar-fill { height: 100%; border-radius: 4px; }
  .rating-bar-fill.star5 { background: #2EA84A; }
  .rating-bar-fill.star4 { background: #7DE69B; }
  .rating-bar-fill.star3 { background: #F59E0B; }
  .rating-bar-fill.star2 { background: #f97316; }
  .rating-bar-fill.star1 { background: #e74c3c; }
  .rating-pct { width: 45px; font-size: 12px; font-weight: 600; }
  .rating-count { width: 35px; font-size: 11px; color: #888; text-align: right; }

  /* Sentiment bar */
  .sentiment-bar { display: flex; height: 28px; border-radius: 6px; overflow: hidden; margin: 12px 0; }
  .sentiment-pos { background: #2EA84A; }
  .sentiment-neu { background: #F59E0B; }
  .sentiment-neg { background: #e74c3c; }
  .sentiment-legend { display: flex; gap: 16px; font-size: 12px; margin-top: 8px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 4px; vertical-align: middle; }

  /* Response rate */
  .response-rate-bar { height: 12px; background: #f0f0f0; border-radius: 6px; overflow: hidden; margin: 8px 0; }
  .response-rate-fill { height: 100%; background: #2EA84A; border-radius: 6px; }
  .response-pct { font-size: 32px; font-weight: 900; }
  .response-detail { font-size: 12px; color: #666; }

  /* Theme bars */
  .theme-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 8px; }
  .theme-info { flex: 0 0 220px; }
  .theme-name { font-weight: 700; font-size: 14px; display: block; }
  .theme-count { font-size: 12px; color: #888; }
  .theme-bar-container { flex: 1; display: flex; height: 14px; border-radius: 4px; overflow: hidden; }
  .theme-bar-pos { background: #2EA84A; }
  .theme-bar-neg { background: #e74c3c; }
  .theme-counts { flex: 0 0 120px; display: flex; gap: 8px; font-size: 11px; font-weight: 600; }
  .pos-count { color: #2EA84A; }
  .neg-count { color: #e74c3c; }
  .risk-badge { background: #e74c3c; color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; vertical-align: middle; margin-left: 6px; }

  /* Staff cards */
  .staff-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .staff-card { border: 1px solid #e8e8e8; border-radius: 8px; padding: 12px 14px; }
  .staff-name { font-weight: 700; font-size: 14px; }
  .staff-role { font-size: 11px; color: #888; }
  .staff-mentions { font-size: 12px; font-weight: 600; margin-top: 4px; }

  /* Driver cards */
  .driver-card { border-left: 4px solid; padding: 12px 16px; margin-bottom: 10px; background: #fafafa; border-radius: 0 8px 8px 0; }
  .driver-card p { font-size: 13px; margin-bottom: 4px; }
  .driver-author { font-size: 11px; color: #888; font-style: italic; }
  .green-border { border-left-color: #2EA84A; }
  .red-border { border-left-color: #e74c3c; }

  /* Risk callout */
  .risk-callout { background: #1a1a1a; color: #fff; padding: 20px 24px; border-radius: 8px; margin-bottom: 12px; }
  .risk-label { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #e74c3c; font-weight: 700; margin-bottom: 10px; }
  .risk-callout p { font-size: 13px; line-height: 1.6; color: #ddd; }
  .risk-callout .driver-author { color: #888; }

  /* Strategic takeaways */
  .takeaway-box { background: #1a1a1a; color: #fff; padding: 20px 24px; border-radius: 8px; margin-bottom: 12px; }
  .takeaway-label-green { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #2EA84A; font-weight: 700; margin-bottom: 8px; }
  .takeaway-label-red { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #e74c3c; font-weight: 700; margin-bottom: 8px; }
  .takeaway-box p { font-size: 13px; color: #ccc; line-height: 1.6; }

  /* Footer */
  .footer { padding: 24px 40px; border-top: 1px solid #e0e0e0; margin-top: 20px; }
  .footer-sources { font-size: 10px; color: #999; line-height: 1.6; }
  .footer-bar { display: flex; justify-content: space-between; margin-top: 12px; font-size: 11px; color: #888; }

  /* Print */
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { max-width: 100%; }
    .section { page-break-inside: avoid; }
    .staff-grid { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <div class="header-label">GOOGLE REVIEWS REPORT</div>
      <div class="header-title">${mainName}${locationTag ? ` <span class="tag">${locationTag}</span>` : ''}</div>
      <div class="header-address">${address || ''}</div>
    </div>
    <div class="header-rating">
      <div class="big-number">${avg_rating || 'N/A'}</div>
      <div class="out-of">out of 5.0</div>
    </div>
  </div>

  <!-- STATS BAR -->
  <div class="stats-bar">
    <div class="stat-item"><div class="stat-label">Reviews Analyzed</div><div class="stat-value">${total_reviews_analyzed?.toLocaleString()}</div></div>
    <div class="stat-item"><div class="stat-label">Date Range</div><div class="stat-value">${date_range?.oldest || 'N/A'} - ${date_range?.newest || 'N/A'}</div></div>
    <div class="stat-item"><div class="stat-label">Positive</div><div class="stat-value green">${pctPositive}%</div></div>
    <div class="stat-item"><div class="stat-label">Negative</div><div class="stat-value red">${pctNegative}%</div></div>
    <div class="stat-item"><div class="stat-label">Response Rate</div><div class="stat-value">${response_rate?.pct || 0}%</div></div>
    <div class="stat-item"><div class="stat-label">Source</div><div class="stat-value">DataForSEO</div></div>
  </div>

  <div class="content">

    <!-- RATING + SENTIMENT -->
    <div class="two-col">
      <div class="section">
        <div class="section-title">Rating Distribution</div>
        <div class="rating-bars">
          ${[5,4,3,2,1].map(s => `<div class="rating-row">
            <span class="rating-label">${s} star</span>
            <div class="rating-bar-bg"><div class="rating-bar-fill star${s}" style="width:${rdPcts[s]}%"></div></div>
            <span class="rating-pct">${rdPcts[s]}%</span>
            <span class="rating-count">${rating_distribution[s]?.toLocaleString()}</span>
          </div>`).join('')}
        </div>
      </div>

      <div>
        <div class="section">
          <div class="section-title">Sentiment Breakdown</div>
          <div class="sentiment-bar">
            <div class="sentiment-pos" style="width:${pctPositive}%"></div>
            <div class="sentiment-neu" style="width:${pctNeutral}%"></div>
            <div class="sentiment-neg" style="width:${pctNegative}%"></div>
          </div>
          <div class="sentiment-legend">
            <span><span class="legend-dot" style="background:#2EA84A"></span> Positive (${sentiment_breakdown.positive?.toLocaleString()})</span>
            <span><span class="legend-dot" style="background:#F59E0B"></span> Neutral (${sentiment_breakdown.neutral?.toLocaleString()})</span>
            <span><span class="legend-dot" style="background:#e74c3c"></span> Negative (${sentiment_breakdown.negative?.toLocaleString()})</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Response Rate</div>
          <div class="response-pct">${response_rate?.pct || 0}%</div>
          <div class="response-rate-bar"><div class="response-rate-fill" style="width:${response_rate?.pct || 0}%"></div></div>
          <div class="response-detail">${response_rate?.responded || 0} of ${total_reviews_analyzed?.toLocaleString()} reviews received an owner response.</div>
        </div>
      </div>
    </div>

    <!-- TOP THEMES -->
    <div class="section">
      <div class="section-title">Top Themes</div>
      ${themeBarsHTML}
    </div>

    <!-- STAFF NAMED -->
    ${mentioned_names?.length > 0 ? `<div class="section">
      <div class="section-title">Staff Named in Reviews</div>
      <div class="staff-grid">${staffCardsHTML}</div>
    </div>` : ''}

    <!-- WHAT PATIENTS LOVE -->
    ${positiveQuotes.length > 0 ? `<div class="section">
      <div class="section-title">What Patients Love (5-Star Drivers)</div>
      ${positiveDriversHTML}
    </div>` : ''}

    <!-- RECURRING NEGATIVES -->
    ${negativeQuotes.length > 0 ? `<div class="section">
      <div class="section-title">Recurring Negatives (1-2 Star Drivers)</div>
      ${negativeDriversHTML}
    </div>` : ''}

    <!-- STRATEGIC TAKEAWAYS -->
    <div class="section">
      <div class="section-title">Strategic Takeaways</div>
      <div class="takeaway-box">
        <div class="takeaway-label-green">STRENGTHS TO AMPLIFY</div>
        <p>${top_themes?.filter(t => t.positive_mentions > t.negative_mentions).map(t => `<strong>${t.theme}</strong> (${t.positive_mentions} positive mentions)`).join(', ') || 'Analysis pending'}</p>
      </div>
      ${riskThemes.length > 0 ? `<div class="takeaway-box">
        <div class="takeaway-label-red">RISKS TO ADDRESS</div>
        <p>${riskThemes.map(t => `<strong>${t.theme}</strong> (${t.negative_mentions} negative mentions)`).join(', ')}</p>
      </div>` : ''}
    </div>

  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="footer-sources">Sources: DataForSEO Google Reviews API: ${total_reviews_analyzed?.toLocaleString()} reviews pulled for ${location_name}${address ? ', ' + address : ''}. Reviews from ${date_range?.oldest || 'N/A'} through ${date_range?.newest || 'N/A'}. ${total_reviews_available?.toLocaleString()} total reviews available on Google.</div>
    <div class="footer-bar">
      <span>${location_name} - Review Report</span>
      <span>Baptist Health Marketing Technology | ${monthYear}</span>
    </div>
  </div>

</div>
</body>
</html>`;
}

module.exports = { generateReviewReportHTML };
