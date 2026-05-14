// reviews-skill.js — Google Reviews Report Skill (DataForSEO)
// Server-side review analysis: fetch, extract names, analyze themes, generate CSV
// Returns compact summary to Claude instead of raw review data

const fs = require('fs');
const path = require('path');

const REVIEWS_DIR = path.join(__dirname, 'data', 'reviews');
const BASE_URL = 'https://api.dataforseo.com/v3/business_data/google/reviews';

// South Florida place/brand stopwords — not people names
const NAME_STOPWORDS = new Set([
  'miami', 'kendall', 'homestead', 'doral', 'aventura', 'brickell', 'hialeah',
  'pembroke', 'miramar', 'davie', 'plantation', 'hollywood', 'sunrise', 'weston',
  'tamarac', 'lauderdale', 'pompano', 'boca', 'delray', 'boynton', 'jupiter',
  'palm', 'coral', 'gables', 'grove', 'springs', 'lakes', 'pines', 'beach',
  'baptist', 'memorial', 'jackson', 'cleveland', 'mount', 'sinai', 'nicklaus',
  'broward', 'mercy', 'bethesda', 'good', 'samaritan', 'northwest',
  'florida', 'south', 'north', 'west', 'east', 'health', 'hospital', 'medical',
  'center', 'clinic', 'urgent', 'care', 'emergency', 'room', 'doctor', 'nurse',
  'thank', 'thanks', 'great', 'good', 'best', 'worst', 'terrible', 'amazing',
  'google', 'review', 'star', 'stars', 'rating', 'experience', 'patient',
  'staff', 'front', 'desk', 'waiting', 'billing', 'insurance', 'covid',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'everything', 'everyone', 'someone', 'nothing', 'anything', 'something',
  'all', 'every', 'each', 'this', 'that', 'they', 'them', 'their', 'there',
  'here', 'where', 'what', 'when', 'which', 'very', 'much', 'more', 'most',
  'also', 'just', 'only', 'even', 'still', 'never', 'always', 'really',
  'from', 'for', 'the', 'and', 'but', 'with', 'treating', 'helping', 'being'
]);

// ─── Auth helper ───────────────────────────────────────────────
function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set in .env');
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

// ─── Date filter parsing ───────────────────────────────────────
function parseDateFilter(since) {
  if (!since) return null;

  // Unix timestamp (all digits)
  if (/^\d{10,}$/.test(since)) return new Date(parseInt(since) * 1000);

  // ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) return new Date(since);

  // Relative: "6 months ago", "last year", "last 3 months", "last week"
  const now = new Date();
  const lower = since.toLowerCase().trim();

  const relMatch = lower.match(/(?:last\s+)?(\d+)\s*(day|week|month|year)s?\s*(?:ago)?/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    if (unit === 'day') now.setDate(now.getDate() - n);
    else if (unit === 'week') now.setDate(now.getDate() - n * 7);
    else if (unit === 'month') now.setMonth(now.getMonth() - n);
    else if (unit === 'year') now.setFullYear(now.getFullYear() - n);
    return now;
  }

  if (lower === 'last year') { now.setFullYear(now.getFullYear() - 1); return now; }
  if (lower === 'last month') { now.setMonth(now.getMonth() - 1); return now; }
  if (lower === 'last week') { now.setDate(now.getDate() - 7); return now; }

  // Try native parse as fallback
  const parsed = new Date(since);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ─── Google Places: resolve place_id ──────────────────────────
async function resolvePlaceId(query) {
  const gmapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!gmapsKey) throw new Error('GOOGLE_MAPS_API_KEY must be set in .env');

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?key=${gmapsKey}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();

  const place = data.results?.[0];
  if (!place) throw new Error(`No Google Places result for: "${query}". Try a more specific name or address.`);

  return {
    place_id: place.place_id,
    name: place.name,
    address: place.formatted_address,
    rating: place.rating,
    total_reviews: place.user_ratings_total
  };
}

// ─── DataForSEO: submit task ──────────────────────────────────
async function submitReviewTask(placeId, depth, sortBy = 'newest') {
  const priority = depth <= 200 ? 2 : 1;
  const body = [{
    place_id: placeId,
    location_name: 'United States',
    language_name: 'English',
    depth: Math.min(Math.ceil(depth / 10) * 10, 4490), // round up to 10, cap at 4490
    sort_by: sortBy,
    priority
  }];

  const res = await fetch(`${BASE_URL}/task_post`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.status_code !== 20000) {
    throw new Error(`DataForSEO task_post failed: ${data.status_message || JSON.stringify(data)}`);
  }

  const task = data.tasks?.[0];
  if (!task?.id) {
    throw new Error(`DataForSEO task_post returned no task ID: ${task?.status_message || 'unknown'}`);
  }
  if (task.status_code !== 20100) {
    throw new Error(`DataForSEO task error: ${task.status_message}`);
  }

  return { taskId: task.id, priority, cost: task.cost };
}

// ─── DataForSEO: poll for results ─────────────────────────────
async function pollForResults(taskId, priority, progressCb) {
  const maxWaitMs = priority === 2 ? 3 * 60 * 1000 : 10 * 60 * 1000;
  const pollIntervalMs = 5000;
  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempts++;
    await new Promise(r => setTimeout(r, pollIntervalMs));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (progressCb) progressCb({ phase: 'polling', elapsed_seconds: elapsed, attempts });

    // Check if task is ready
    const readyRes = await fetch(`${BASE_URL}/tasks_ready`, {
      headers: { 'Authorization': authHeader() }
    });
    const readyData = await readyRes.json();

    const readyTasks = readyData.tasks?.[0]?.result || [];
    const isReady = readyTasks.some(t => t.id === taskId);

    if (isReady) {
      // Fetch results
      const resultRes = await fetch(`${BASE_URL}/task_get/${taskId}`, {
        headers: { 'Authorization': authHeader() }
      });
      const resultData = await resultRes.json();

      if (resultData.status_code !== 20000) {
        throw new Error(`DataForSEO task_get failed: ${resultData.status_message}`);
      }

      const task = resultData.tasks?.[0];
      if (task?.status_code !== 20000) {
        throw new Error(`DataForSEO task error: ${task?.status_message || 'Unknown error'}`);
      }

      return {
        reviews: task.result?.[0]?.items || [],
        totalAvailable: task.result?.[0]?.reviews_count || 0,
        locationName: task.result?.[0]?.title || '',
        overallRating: task.result?.[0]?.rating?.value || null,
        cost: task.cost
      };
    }
  }

  throw new Error(`DataForSEO polling timed out after ${Math.round(maxWaitMs / 1000)}s. Task ${taskId} not ready.`);
}

// ─── Client-side date filter ──────────────────────────────────
function filterByDate(reviews, sinceDate) {
  if (!sinceDate) return reviews;
  return reviews.filter(r => {
    if (!r.timestamp) return true;
    return new Date(r.timestamp) >= sinceDate;
  });
}

// ─── Name extraction ──────────────────────────────────────────
function extractMentionedNames(reviews) {
  const nameMap = new Map(); // name -> { count, sentiment: {pos, neg}, snippets: [] }

  const patterns = [
    // "Dr. Rodriguez", "Doctor Patel"
    /\b(?:Dr\.?|Doctor)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/g,
    // "Nurse Jackie", "RN Maria"
    /\b(?:Nurse|RN|NP|PA)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/g,
    // "thank you [Name]", "thanks to [Name]", "shout out to [Name]" — name must start with capital
    /(?:thank(?:s|\s+you)(?:\s+(?:to|so\s+much(?:\s+to)?))?|shout\s*out\s+to)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)(?!\s+(?:for|from|and|the|all|who|that|this|at|in|on))/g,
    // "[Name] was amazing/terrible/helpful/rude..."
    /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\s+(?:was|is|has\s+been)\s+(?:amazing|wonderful|great|excellent|fantastic|incredible|outstanding|terrible|rude|awful|horrible|helpful|kind|caring|attentive|dismissive|unprofessional|professional|the\s+best|so\s+kind|so\s+helpful|very\s+nice|very\s+rude|phenomenal|compassionate|patient|gentle|thorough)/g
  ];

  for (const review of reviews) {
    const text = review.review_text || '';
    if (!text) continue;

    const rating = review.rating?.value || 0;
    const isPositive = rating >= 4;
    const isNegative = rating <= 2;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let name = match[1].trim();

        // Skip stopwords
        const firstWord = name.split(/\s+/)[0].toLowerCase();
        if (NAME_STOPWORDS.has(firstWord)) continue;
        if (name.length < 3) continue;

        // Normalize: if preceded by Dr./Doctor, prepend it
        const prefix = match[0].match(/^(Dr\.?|Doctor)\s/i);
        if (prefix && !name.startsWith('Dr')) {
          name = `Dr. ${name}`;
        }

        if (!nameMap.has(name)) {
          nameMap.set(name, { count: 0, positive: 0, negative: 0, neutral: 0, snippets: [] });
        }
        const entry = nameMap.get(name);
        entry.count++;
        if (isPositive) entry.positive++;
        else if (isNegative) entry.negative++;
        else entry.neutral++;

        // Keep up to 3 context snippets
        if (entry.snippets.length < 3) {
          const start = Math.max(0, match.index - 40);
          const end = Math.min(text.length, match.index + match[0].length + 60);
          entry.snippets.push(text.substring(start, end).replace(/\n/g, ' ').trim());
        }
      }
    }
  }

  // Sort by count, return top 20
  return Array.from(nameMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([name, data]) => {
      const total = data.positive + data.negative + data.neutral;
      let sentiment = 'mixed';
      if (data.positive / total > 0.7) sentiment = 'positive';
      else if (data.negative / total > 0.7) sentiment = 'negative';
      return {
        name,
        count: data.count,
        sentiment,
        positive_mentions: data.positive,
        negative_mentions: data.negative,
        sample: data.snippets[0] || ''
      };
    });
}

// ─── Theme analysis ───────────────────────────────────────────
function analyzeThemes(reviews) {
  const themes = {
    'Wait times': {
      positive: /\b(quick|fast|no\s+wait|short\s+wait|on\s+time|prompt|efficient|didn'?t\s+wait\s+long|seen\s+right\s+away|minimal\s+wait)\b/gi,
      negative: /\b(long\s+wait|waited\s+\d+|hours?\s+wait|slow|forever|took\s+so\s+long|waiting\s+room|still\s+waiting|waited\s+forever|excessive\s+wait)\b/gi
    },
    'Staff & bedside manner': {
      positive: /\b(friendly|kind|caring|compassionate|attentive|warm|welcoming|sweet|patient|gentle|courteous|pleasant|respectful|supportive|thoughtful|empathetic)\b/gi,
      negative: /\b(rude|dismissive|cold|uncaring|disrespectful|impatient|condescending|unprofessional|nasty|unfriendly|arrogant|hostile|insensitive|neglect)\b/gi
    },
    'Clinical quality': {
      positive: /\b(thorough|knowledgeable|skilled|competent|accurate|diagnosis|saved|cured|healed|expert|experienced|top\s+notch|excellent\s+care|life\s*sav)\b/gi,
      negative: /\b(misdiagnos|wrong\s+diagnosis|malpractice|incompetent|negligent|mistake|botched|worse|deteriorat|incorrect|missed|overlooked|failed\s+to)\b/gi
    },
    'Billing & insurance': {
      positive: /\b(reasonable|affordable|fair\s+price|transparent\s+billing|covered|good\s+value|worth)\b/gi,
      negative: /\b(overcharg|expensive|bill|billing\s+issue|surprise\s+charge|hidden\s+fee|insurance\s+issue|out\s+of\s+pocket|ridiculous\s+price|charged\s+me|price\s+goug|rip\s*off)\b/gi
    },
    'Facility & cleanliness': {
      positive: /\b(clean|modern|new|nice\s+facility|well\s+maintained|comfortable|spacious|organized|updated|beautiful|state\s+of\s+the\s+art)\b/gi,
      negative: /\b(dirty|filthy|outdated|cramped|old|run\s*down|unsanitary|messy|disgusting|cockroach|bug|smell|stink|mold)\b/gi
    },
    'Communication': {
      positive: /\b(explained|listened|answered\s+questions|informative|kept\s+me\s+informed|clear|communicated|responsive|follow\s*up|called\s+back|took\s+time\s+to)\b/gi,
      negative: /\b(didn'?t\s+listen|no\s+communication|ignored|couldn'?t\s+reach|never\s+called|unanswered|no\s+follow|didn'?t\s+explain|rushed|brush\s*off|no\s+one\s+answer|left\s+in\s+the\s+dark)\b/gi
    }
  };

  const results = [];

  for (const [theme, patterns] of Object.entries(themes)) {
    let posCount = 0;
    let negCount = 0;

    for (const review of reviews) {
      const text = review.review_text || '';
      if (!text) continue;

      const posMatches = text.match(patterns.positive);
      const negMatches = text.match(patterns.negative);
      if (posMatches) posCount += posMatches.length;
      if (negMatches) negCount += negMatches.length;
    }

    const total = posCount + negCount;
    if (total === 0) continue;

    let sentiment = 'mixed';
    if (posCount > 0 && negCount === 0) sentiment = 'positive';
    else if (negCount > 0 && posCount === 0) sentiment = 'negative';
    else if (posCount / total > 0.65) sentiment = 'mostly positive';
    else if (negCount / total > 0.65) sentiment = 'mostly negative';

    results.push({
      theme,
      mentions: total,
      positive_mentions: posCount,
      negative_mentions: negCount,
      sentiment
    });
  }

  return results.sort((a, b) => b.mentions - a.mentions);
}

// ─── Stats computation ────────────────────────────────────────
function computeStats(reviews) {
  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let ratingSum = 0;
  let ratingCount = 0;
  let oldest = null;
  let newest = null;

  for (const r of reviews) {
    const val = r.rating?.value;
    if (val >= 1 && val <= 5) {
      dist[val]++;
      ratingSum += val;
      ratingCount++;
    }

    if (r.timestamp) {
      const d = new Date(r.timestamp);
      if (!oldest || d < oldest) oldest = d;
      if (!newest || d > newest) newest = d;
    }
  }

  const positive = dist[5] + dist[4];
  const neutral = dist[3];
  const negative = dist[2] + dist[1];

  return {
    avg_rating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
    rating_distribution: dist,
    sentiment_breakdown: { positive, neutral, negative },
    date_range: {
      oldest: oldest ? oldest.toISOString().split('T')[0] : null,
      newest: newest ? newest.toISOString().split('T')[0] : null
    },
    total_with_owner_response: reviews.filter(r => r.owner_answer).length,
    total_without_response: reviews.filter(r => !r.owner_answer).length,
    pct_responded: reviews.length > 0
      ? Math.round((reviews.filter(r => r.owner_answer).length / reviews.length) * 100)
      : 0
  };
}

// ─── CSV generation ───────────────────────────────────────────
function escapeCSV(val) {
  if (val == null) return '';
  const str = String(val).replace(/\r?\n/g, ' ');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function generateCSV(locationName, reviews, mentionedNames) {
  // Build a set of mentioned names for tagging
  const nameSet = new Set(mentionedNames.map(n => n.name.toLowerCase()));

  const headers = [
    'date', 'rating', 'author', 'local_guide', 'review_text',
    'owner_response', 'review_url', 'mentioned_names', 'original_language'
  ];

  const rows = [headers.join(',')];

  for (const r of reviews) {
    // Find names mentioned in this specific review
    const reviewNames = mentionedNames
      .filter(n => (r.review_text || '').toLowerCase().includes(n.name.toLowerCase().replace('dr. ', '')))
      .map(n => n.name)
      .join('; ');

    rows.push([
      escapeCSV(r.timestamp ? new Date(r.timestamp).toISOString().split('T')[0] : ''),
      escapeCSV(r.rating?.value || ''),
      escapeCSV(r.profile_name || ''),
      escapeCSV(r.local_guide ? 'Yes' : 'No'),
      escapeCSV(r.review_text || ''),
      escapeCSV(r.owner_answer || ''),
      escapeCSV(r.review_url || ''),
      escapeCSV(reviewNames),
      escapeCSV(r.original_language || 'en')
    ].join(','));
  }

  // Write file
  const safeName = locationName.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
  const date = new Date().toISOString().split('T')[0];
  const filename = `reviews-${safeName}-${date}-${reviews.length}reviews.csv`;
  const filepath = path.join(REVIEWS_DIR, filename);

  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(filepath, rows.join('\n'), 'utf-8');

  return filename;
}

// ─── Build full result with reviews ───────────────────────────
function buildFullResult(locationName, reviews, stats, names, themes, csvFilename, totalAvailable, cost) {
  // Include full review text so Claude can parse, search, and report on anything the user asks
  const reviewsForClaude = reviews.map(r => ({
    date: r.timestamp ? new Date(r.timestamp).toISOString().split('T')[0] : null,
    rating: r.rating?.value || null,
    author: r.profile_name || null,
    local_guide: r.local_guide || false,
    text: r.review_text || '',
    owner_response: r.owner_answer || null,
    language: r.original_language || 'en'
  }));

  return {
    location_name: locationName,
    total_reviews_analyzed: reviews.length,
    total_reviews_available: totalAvailable,
    avg_rating: stats.avg_rating,
    rating_distribution: stats.rating_distribution,
    date_range: stats.date_range,
    response_rate: {
      responded: stats.total_with_owner_response,
      unresponded: stats.total_without_response,
      pct: stats.pct_responded
    },
    mentioned_names: names.slice(0, 20),
    top_themes: themes,
    sentiment_breakdown: stats.sentiment_breakdown,
    csv_download_url: csvFilename ? `/api/reviews/${csvFilename}` : null,
    reviews: reviewsForClaude
  };
}

// ─── Main entry point ─────────────────────────────────────────
async function executeReviewsReport(input, progressCb) {
  const { query, reviewsLimit, since, include_csv } = input;

  // 1. Resolve place_id via Google Places
  if (progressCb) progressCb({ phase: 'progress', message: `Looking up "${query}" on Google Maps...` });
  const place = await resolvePlaceId(query);
  if (progressCb) progressCb({ phase: 'progress', message: `Found: ${place.name} (${place.total_reviews} reviews on Google). Submitting to DataForSEO...` });

  // 3. Pull the exact amount requested — sorted newest first, dates included on every review
  const depth = Math.min(reviewsLimit || 200, 4490);
  const { taskId, priority, cost: submitCost } = await submitReviewTask(place.place_id, depth);

  if (progressCb) progressCb({ phase: 'progress', message: `Task submitted (priority ${priority === 2 ? 'high' : 'standard'}). Polling for results...` });

  // 4. Poll for results
  const result = await pollForResults(taskId, priority, (status) => {
    if (progressCb) progressCb({ phase: 'progress', message: `Waiting for reviews... ${status.elapsed_seconds}s elapsed` });
  });

  let reviews = result.reviews;
  if (progressCb) progressCb({ phase: 'progress', message: `Received ${reviews.length} reviews. Analyzing...` });

  // 5. Analyze
  const names = extractMentionedNames(reviews);
  const themes = analyzeThemes(reviews);
  const stats = computeStats(reviews);

  // 6. Generate CSV (default true for 50+ reviews)
  let csvFilename = null;
  const shouldCSV = include_csv !== false && reviews.length >= 10;
  if (shouldCSV) {
    csvFilename = generateCSV(result.locationName || query, reviews, names);
    if (progressCb) progressCb({ phase: 'progress', message: `CSV generated: ${csvFilename}` });
  }

  // 7. Build full result with reviews for Claude to parse
  const fullResult = buildFullResult(
    result.locationName || place.name || query,
    reviews, stats, names, themes, csvFilename,
    result.totalAvailable, result.cost
  );

  return fullResult;
}

// ─── CSV cleanup (call periodically) ──────────────────────────
function cleanupOldCSVs(maxAgeDays = 7) {
  if (!fs.existsSync(REVIEWS_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(REVIEWS_DIR)) {
    const filepath = path.join(REVIEWS_DIR, file);
    const stat = fs.statSync(filepath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filepath);
      console.log(`[Reviews] Cleaned up old CSV: ${file}`);
    }
  }
}

module.exports = { executeReviewsReport, cleanupOldCSVs, parseDateFilter, extractMentionedNames, analyzeThemes };
