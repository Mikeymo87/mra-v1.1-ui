require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { insertRun, updateRun, insertToolCall } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Basic Auth (skip if MRA_USERNAME not set) ──────────────────────────────
function basicAuth(req, res, next) {
  if (!process.env.MRA_USERNAME) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="MRA"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === process.env.MRA_USERNAME && pass === process.env.MRA_PASSWORD) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="MRA"');
  return res.status(401).send('Invalid credentials');
}
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiting ──────────────────────────────────────────────────────────
const rateLimits = new Map();
const RATE_LIMIT = 30; // queries per hour
const RATE_WINDOW = 60 * 60 * 1000;

function checkRateLimit(sessionId) {
  const now = Date.now();
  let entry = rateLimits.get(sessionId);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  rateLimits.set(sessionId, entry);
  return entry.count <= RATE_LIMIT;
}

// ── Config ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;
const MAX_MESSAGES = 40;
const MAX_ITERATIONS = 25;

// Cleanup stale sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// ── Modular System Prompt ─────────────────────────────────────────���────────
const PROMPT_DIR = path.join(__dirname, 'prompts');
const CORE_PROMPT = fs.readFileSync(path.join(PROMPT_DIR, 'core.txt'), 'utf8');
let REF_PROMPT = fs.readFileSync(path.join(PROMPT_DIR, 'reference-data.txt'), 'utf8');

const WORKFLOW_FILES = {
  demographics: 'workflow-demographics.txt',
  locations: 'workflow-locations.txt',
  physicians: 'workflow-physicians.txt',
  competitive: 'workflow-competitive.txt',
  psychographic: 'workflow-psychographic.txt',
  facility: 'workflow-facility-planning.txt',
  trade_area: 'workflow-trade-area.txt',
};

const WORKFLOW_PROMPTS = {};
for (const [key, file] of Object.entries(WORKFLOW_FILES)) {
  try {
    WORKFLOW_PROMPTS[key] = fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8');
  } catch (e) {
    console.warn(`  Workflow file missing: ${file}`);
    WORKFLOW_PROMPTS[key] = '';
  }
}

// ── Service Line Extraction ────────────────────────────────────────────────
const SERVICE_LINE_KEYWORDS = {
  cardiology: ['cardiology', 'cardio', 'heart', 'cardiac', 'cardiovascular'],
  orthopedics: ['orthopedics', 'ortho', 'orthopedic', 'sports medicine', 'joint replacement', 'spine'],
  imaging: ['imaging', 'radiology', 'mri', 'ct scan', 'x-ray', 'diagnostic imaging'],
  primary_care: ['primary care', 'pcp', 'family medicine', 'internal medicine', 'family doctor'],
  urgent_care: ['urgent care', 'walk-in', 'same-day care', 'same day care'],
  neurology: ['neurology', 'neuro', 'neuroscience', 'brain', 'neurologist'],
  oncology: ['oncology', 'cancer', 'oncologist', 'cancer care'],
  surgery: ['surgery', 'surgical', 'outpatient surgery'],
  womens_health: ['women', 'gynecology', 'obgyn', 'ob/gyn', 'obstetrics', 'maternity'],
  urology: ['urology', 'urologist', 'urolog'],
  gastroenterology: ['gastroenterology', 'gastro clinic', 'endoscopy'],
  pulmonology: ['pulmon', 'pulmonology', 'lung'],
  physical_therapy: ['physical therapy', 'rehabilitation', 'rehab'],
  emergency: ['emergency room', 'emergency department', 'emergency care'],
};

function extractServiceLines(query) {
  const q = query.toLowerCase();
  const found = [];
  for (const [line, keywords] of Object.entries(SERVICE_LINE_KEYWORDS)) {
    if (keywords.some(kw => q.includes(kw))) found.push(line);
  }
  // "multi-specialty" without specific lines → default exploratory set
  if (/multi.?specialty/i.test(q) && found.length === 0) {
    return ['primary_care', 'cardiology', 'orthopedics', 'imaging'];
  }
  return found;
}

// ── Mode + Plan Type + Intent Detection ────────────────────────────────────
function detectMode(query) {
  if (/section\s*[0-9]|marketing\s*plan|plan\s*mode|plan\s*brief|plan\s*type|MRA Request|for\s*the\s*plan/i.test(query))
    return 'marketing_plan';
  return 'general_research';
}

function detectPlanType(query) {
  const q = query.toLowerCase();
  if (/facility\s*open|new\s*(facility|center|clinic|building|location|medical)|opening\s*date/i.test(q)) return 'facility_opening';
  if (/partnership|affiliation|referral\s*network|replacing.*as.*partner|one\s*medical.*partner/i.test(q)) return 'partnership_launch';
  if (/service\s*line\s*(plan|expan)|grow(ing|th)?\s*(the\s*)?service|expand\s*(the\s*)?(service|cardio|ortho|neuro|imaging|primary|oncol)/i.test(q)) return 'service_line';
  if (/brand\s*(plan|campaign)|system\s*(plan|wide)|awareness\s*campaign/i.test(q)) return 'brand_system';
  return null;
}

function classifyIntent(query) {
  const q = query.toLowerCase();
  const mode = detectMode(query);
  const planType = mode === 'marketing_plan' ? detectPlanType(query) : null;
  const intents = new Set();

  // Core intent detection
  if (/demograph|payer\s*mix|population|income|insurance|census|age.*(breakdown|distribution)|median.*household|commercially\s*addressable/i.test(q))
    intents.add('demographics');
  if (/where.*(bh|baptist)|find.*(location|facility|clinic)|locations?\s*(near|within)|what.*(locations?|facilities?)|network\s*inventory|footprint/i.test(q))
    intents.add('locations');
  if (/physician|doctor|specialist|cardiologist|orthopedist|neurologist|oncologist|surgeon|referral.*physician|who.*(bh|baptist).*(doctor|physician)|find.*(cardio|ortho|neuro|family\s*medicine|internal\s*medicine)|(bh|baptist).*(cardio|ortho|neuro|physician)/i.test(q))
    intents.add('physicians');
  if (/competitor|competition|competitive|rival|hca|jackson|cleveland\s*clinic|memorial|mount\s*sinai|threat|who.*there|who.*nearby/i.test(q))
    intents.add('competitive');
  if (/psychograph|segment|tapestry|lifestyle|cohort|health\s*behavior|cdc|behavioral|preventive\s*care|chronic\s*disease/i.test(q))
    intents.add('psychographic');
  if (/new\s*facility|cannibali|feeder|referral\s*corridor|overlap.*feeder/i.test(q))
    intents.add('facility');
  if (/permit|construction|ahca|building\s*permit|facility\s*filing|what.*being\s*built|who.*building|new.*hospital|expansion|broke\s*ground/i.test(q))
    intents.add('competitive');
  if (/trade\s*area|define.*area|what\s*zips|which\s*zips|zips\s*(near|around|within)/i.test(q))
    intents.add('trade_area');

  // Review-specific (general research)
  if (/review|sentiment|what.*patients.*say|review\s*theme/i.test(q) && !intents.has('competitive'))
    intents.add('competitive'); // reviews use competitive workflow

  // Rating-only queries shouldn't load full competitive workflow context
  if (/\brating\b|\bstars\b|\brated\b/i.test(q) && !intents.has('competitive'))
    intents.add('competitive');

  // Marketing plan section-specific routing (only add what the section needs)
  if (mode === 'marketing_plan') {
    if (/section\s*2/i.test(q)) {
      intents.add('competitive');
      intents.add('demographics');
    }
    if (/section\s*4/i.test(q)) {
      intents.add('competitive');
      intents.add('locations'); // need BH footprint for competitive context
    }
    if (/section\s*5/i.test(q)) {
      intents.add('demographics');
      intents.add('psychographic');
      // Auto-add trade area if address present but no ZIPs
      if (/\d{5}/.test(q) === false && /\d+\s+\w/.test(q)) intents.add('trade_area');
    }
    if (/section\s*(10|11)/i.test(q)) {
      intents.add('locations');
      intents.add('facility');
    }
  }

  // Fallback: load all workflows
  if (intents.size === 0) {
    Object.keys(WORKFLOW_FILES).forEach(k => intents.add(k));
  }
  return [...intents];
}

// ── Evidence Coverage Tracker ──────────────────────────────────────────────
// Lightweight tracker that watches tool calls and checks minimum evidence
function createEvidenceCoverage(mode, planType, intents, serviceLines) {
  const coverage = {
    mode,
    planType,
    intents,
    serviceLines,
    toolsCalled: [],
    bhServiceLinesSearched: [],
    competitorSearches: [],
    geocodeDone: false,
    driveTimesDone: false,
    censusDone: false,
    cdcDone: false,
    missing: [],
  };
  return coverage;
}

function updateEvidenceCoverage(coverage, toolName, toolInput) {
  coverage.toolsCalled.push(toolName);

  if (toolName === 'geocode_address') coverage.geocodeDone = true;
  if (toolName === 'calculate_drive_times') coverage.driveTimesDone = true;
  if (toolName === 'census_demographics_lookup') coverage.censusDone = true;
  if (toolName === 'cdc_health_behaviors' || toolName === 'generate_choropleth_map') coverage.cdcDone = true;

  if (toolName === 'baptist_health_location_lookup') {
    const raw = toolInput.filter || '';
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
    const match = decoded.match(/\$contains[^"]*"([^"]+)"/);
    if (match) coverage.bhServiceLinesSearched.push(match[1]);
    // Also check URL-encoded patterns
    if (!match) {
      const encMatch = raw.match(/%22%24contains%22.*?%22([^%]+)%22/i);
      if (encMatch) coverage.bhServiceLinesSearched.push(decodeURIComponent(encMatch[1]));
    }
  }

  if (toolName === 'competitor_ratings_reviews') {
    const decoded = decodeURIComponent((toolInput.query || '').replace(/\+/g, ' '));
    coverage.competitorSearches.push(decoded);
  }
}

function checkEvidenceCoverage(coverage) {
  const missing = [];
  const { mode, planType, intents, serviceLines } = coverage;

  // Competitive evidence checks
  if (intents.includes('competitive')) {
    if (!coverage.geocodeDone && mode === 'marketing_plan')
      missing.push('Target address was not geocoded — drive times and radius filtering may be inaccurate');

    // Check if BH was searched for each mentioned service line
    if (serviceLines.length > 0 && coverage.bhServiceLinesSearched.length === 0)
      missing.push(`BH locations were not searched. Cannot confirm BH presence or gaps for: ${serviceLines.join(', ')}`);

    if (serviceLines.length > 0 && coverage.competitorSearches.length === 0)
      missing.push(`Competitors were not searched. Cannot assess competitive landscape for: ${serviceLines.join(', ')}`);
  }

  // Demographics evidence checks
  if (intents.includes('demographics') && !coverage.censusDone)
    missing.push('Census demographics were not pulled — demographic claims are unsupported');

  // Psychographic evidence checks
  if (intents.includes('psychographic') && !coverage.cdcDone)
    missing.push('CDC health behaviors were not pulled — behavioral/psychographic claims lack evidence');

  coverage.missing = missing;
  return coverage;
}

function buildSystemPrompt(query) {
  const mode = detectMode(query);
  const planType = mode === 'marketing_plan' ? detectPlanType(query) : null;
  const intents = classifyIntent(query);
  const serviceLines = extractServiceLines(query);

  const workflowText = intents.map(k => WORKFLOW_PROMPTS[k]).filter(Boolean).join('\n\n---\n\n');

  // Build plan-type context block
  let planContext = '';
  if (mode === 'marketing_plan' && planType) {
    planContext = `\n\nPLAN CONTEXT FOR THIS QUERY:\nMode: Marketing Plan\nPlan type: ${planType}\nDetected service lines: ${serviceLines.length > 0 ? serviceLines.join(', ') : 'none detected — ask the user or infer from facility type'}\n`;
  }
  if (serviceLines.length > 0) {
    planContext += `\nSERVICE LINES TO ANALYZE: ${serviceLines.join(', ')}\nYou MUST search BH locations AND competitors for each of these service lines. Do not skip any.\n`;
  }

  const prompt = `${CORE_PROMPT}${planContext}\n\n---\n\n${workflowText}\n\n---\n\n${REF_PROMPT}`;
  console.log(`[Router] Mode: ${mode} | Plan type: ${planType || 'N/A'} | Intents: [${intents.join(', ')}] | Service lines: [${serviceLines.join(', ')}] | Prompt: ${prompt.length} chars`);
  return prompt;
}

// ── Specialty Synonym Map (supports arrays for multi-search) ───────────────
const SPECIALTY_SYNONYMS = {
  'heart doctor': 'Cardio', 'heart': 'Cardio', 'cardiologist': 'Cardio', 'cardiology': 'Cardio', 'cardiovascular': 'Cardio',
  'bone doctor': 'Orthop', 'orthopedic': 'Orthop', 'orthopedics': 'Orthop', 'ortho': 'Orthop',
  'brain doctor': 'Neuro', 'neurologist': 'Neuro', 'neurology': 'Neuro',
  'stomach doctor': 'Gastro', 'gi': 'Gastro', 'gastroenterologist': 'Gastro', 'gastroenterology': 'Gastro',
  'skin doctor': 'Dermatol', 'dermatologist': 'Dermatol', 'dermatology': 'Dermatol',
  'eye doctor': 'Ophthalmol', 'ophthalmologist': 'Ophthalmol', 'ophthalmology': 'Ophthalmol',
  'lung doctor': 'Pulmon', 'pulmonologist': 'Pulmon', 'pulmonology': 'Pulmon',
  'kidney doctor': 'Nephrol', 'nephrologist': 'Nephrol',
  'baby doctor': 'Pediatr', 'pediatrician': 'Pediatr', 'pediatrics': 'Pediatr',
  'obgyn': 'OB', 'ob/gyn': 'OB', 'gynecologist': 'OB', 'obstetrician': 'OB',
  'cancer doctor': 'Oncol', 'oncologist': 'Oncol', 'oncology': 'Oncol',
  'primary care': ['Internal Medicine', 'Family Medicine'], // searches BOTH
  'pcp': ['Family Medicine', 'Internal Medicine'],           // searches BOTH
  'family doctor': 'Family Medicine',
  'mental health': 'Psychiatr', 'psychiatrist': 'Psychiatr', 'psychiatry': 'Psychiatr',
  'pain management': 'Pain', 'pain doctor': 'Pain',
  'joint replacement': 'Orthop', 'back doctor': 'Spine', 'spine doctor': 'Spine',
  'urologist': 'Urolog', 'urology': 'Urolog',
  'rheumatologist': 'Rheumat', 'rheumatology': 'Rheumat',
  'endocrinologist': 'Endocrin', 'endocrinology': 'Endocrin', 'diabetes doctor': 'Endocrin',
};

// ── Warning Helper (structured severity) ───────────────────────────────────
function warn(severity, code, message) {
  return { severity, code, message };
}

// ── City Alias Map ───────────────────────────────────────────��─────────────
const CITY_ALIASES = {
  'ft lauderdale': 'Fort Lauderdale', 'ft. lauderdale': 'Fort Lauderdale',
  'ft pierce': 'Fort Pierce', 'ft. pierce': 'Fort Pierce',
  'n miami': 'North Miami', 'n. miami': 'North Miami',
  'n miami beach': 'North Miami Beach', 'n. miami beach': 'North Miami Beach',
  's miami': 'South Miami', 's. miami': 'South Miami',
  'w palm beach': 'West Palm Beach', 'west palm': 'West Palm Beach',
  'pembroke pnes': 'Pembroke Pines',
  'miami gdns': 'Miami Gardens', 'miami gardens': 'Miami Gardens',
  'hallandale': 'Hallandale Beach',
  'dania': 'Dania Beach',
  'lauderdale lakes': 'Lauderdale Lakes',
  'pompano': 'Pompano Beach',
};

function normalizeCity(city) {
  if (!city) return city;
  return CITY_ALIASES[city.toLowerCase().trim()] || city;
}

// ── Tool Definitions (Anthropic format) ─────────────────────────────────────
const tools = [
  {
    name: 'baptist_health_location_lookup',
    description: 'Looks up Baptist Health South Florida facilities from Yext. Returns name, address, coordinates, and open/closed status. Use for any "where is BH" or "find BH locations" query.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'URL-encoded Yext filter JSON. For ALL BH locations (broad search — use for market profiles, "what do we have nearby", "all locations", or any query needing the full BH footprint): %7B%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D — Returns up to 50 facilities in one call. Single keyword: %7B%22name%22%3A%7B%22%24contains%22%3A%22KEYWORD%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D — KEYWORD examples: Primary%2BCare, Imaging, Orthop, Cardio, Cancer, Neuro, Surgery. For same-day care (FULL category — includes urgent care, express, emergency/ER): %7B%22%24or%22%3A%5B%7B%22name%22%3A%7B%22%24contains%22%3A%22Urgent%2BCare%22%7D%7D%2C%7B%22name%22%3A%7B%22%24contains%22%3A%22Same-Day%2BCare%22%7D%7D%2C%7B%22name%22%3A%7B%22%24contains%22%3A%22Emergency%22%7D%7D%2C%7B%22name%22%3A%7B%22%24contains%22%3A%22Express%22%7D%7D%5D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D'
        }
      },
      required: ['filter']
    }
  },
  {
    name: 'census_demographics_lookup',
    description: 'Fetches US Census ACS 5-Year data for demographics, age/sex breakdown, income, payer mix, and psychographic proxy variables. Supports 3 endpoints: Detailed Tables (default path), Data Profiles (/profile), Subject Tables (/subject). Max 25 variables per call. Server automatically retries with 2023 data if 2024 fails. Server pre-calculates _PCT columns for B01001 age/sex variables.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'Dataset year. Use "2024" first.', enum: ['2024', '2023'] },
        endpoint: { type: 'string', description: 'Endpoint suffix and full query string. MAX 25 variables per call. Examples: /profile?get=NAME,DP03_0097E,DP03_0097PE&for=zip+code+tabulation+area:33131 or /subject?get=NAME,S2704_C02_002E&for=zip+code+tabulation+area:33131 or ?get=NAME,B01001_001E&for=county:086. Multiple ZIPs: comma-separated. State prefix &in=state:12 NOT supported for ZIPs.' }
      },
      required: ['year', 'endpoint']
    }
  },
  {
    name: 'web_research',
    description: 'Web search via Firecrawl. Returns titles, URLs, and short descriptions. Use for market trends, Esri Tapestry segments, competitor news, all-provider searches. Does NOT return full page content — use read_page to get full content from a specific URL. Translate non-English results to English.',
    input_schema: {
      type: 'object',
      properties: {
        research_query: { type: 'string', description: 'Research query. For all-provider searches search broadly including competitors.' }
      },
      required: ['research_query']
    }
  },
  {
    name: 'read_page',
    description: 'Extracts full page content as clean markdown from a specific URL. Use after web_research when you need detailed content from a result. Tries Jina Reader first (free); falls back to Firecrawl scrape for JS-heavy pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to extract content from.' }
      },
      required: ['url']
    }
  },
  {
    name: 'geocode_address',
    description: 'Converts an address to lat/lng coordinates via Google Geocoding API. Server validates that the returned city matches the input city and adds a warning if mismatched.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'URL-encoded address. Replace spaces with +. CRITICAL: Always include the EXACT city name from the user query plus FL and USA. Example: 1400+SW+145th+Ave+Pembroke+Pines+FL+USA' }
      },
      required: ['address']
    }
  },
  {
    name: 'calculate_drive_times',
    description: 'Calculates drive time and distance between locations via Google Distance Matrix API. Server flattens results into explicit {origin, destination, duration, distance} pairs.',
    input_schema: {
      type: 'object',
      properties: {
        origins: { type: 'string', description: 'Pipe-separated origin coordinates as lat,lng. Example: 25.7617,-80.1918|25.7750,-80.2100. Max 25.' },
        destinations: { type: 'string', description: 'Pipe-separated destination coordinates as lat,lng. Max 10 per call for accuracy.' }
      },
      required: ['origins', 'destinations']
    }
  },
  {
    name: 'competitor_ratings_reviews',
    description: 'Google Places Text Search for QUICK competitor rating snapshots (stars, review count, address, place_id). NOT for full review text — use google_reviews_deep_pull for that.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'URL-encoded Google Places search query. Include location. Examples: primary+care+Pembroke+Pines+Florida' }
      },
      required: ['query']
    }
  },
  {
    name: 'google_reviews_deep_pull',
    description: 'Outscraper API for full review data with dates, text, business responses. Supports batch (10 locations), date filtering, up to 100 reviews/location.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'URL-encoded location query. For batch use %0A between locations (max 10).' },
        reviewsLimit: { type: 'number', description: 'Number of reviews per location. 20 for quick check, 50 for analysis, 100 for deep dive.' },
        cutoff: { type: 'string', description: 'Optional Unix timestamp to filter reviews newer than date.' }
      },
      required: ['query', 'reviewsLimit']
    }
  },
  {
    name: 'drive_time_isochrone',
    description: 'Generates drive-time polygon zones as GeoJSON. Pass EITHER lat/lng coordinates OR an address — the server handles geocoding and coordinate formatting automatically. Range in seconds: 300=5min, 600=10min, 900=15min, 1200=20min. Max 3 ranges per call.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude of the origin point. Use this with lng OR use address instead.' },
        lng: { type: 'number', description: 'Longitude of the origin point. Use this with lat OR use address instead.' },
        address: { type: 'string', description: 'Address to generate isochrone from. Server will geocode automatically. Use this OR lat/lng.' },
        range: { type: 'array', description: 'Array of range values in seconds.', items: { type: 'number' } }
      },
      required: ['range']
    }
  },
  {
    name: 'baptist_health_physician_lookup',
    description: 'Looks up Baptist Health physicians from Yext. Returns name, specialty, degrees, address, coordinates, phone, languages, NPI, ratings, accepting status. Server normalizes specialty synonyms automatically (e.g., "heart doctor" → "Cardio"). Use c_listOfSpecialties for filter. IMPORTANT: For geographic searches, you MUST search ALL adjacent cities per the city adjacency map.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'URL-encoded Yext filter JSON. By specialty+city: %7B%22c_listOfSpecialties%22%3A%7B%22%24contains%22%3A%22SPECIALTY%22%7D%2C%22address.city%22%3A%7B%22%24eq%22%3A%22CITY%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D' }
      },
      required: ['filter']
    }
  },
  {
    name: 'cdc_health_behaviors',
    description: 'Looks up CDC PLACES health behavior data for South Florida ZIP codes. Returns 33 measures per ZIP. Coverage: 195 ZIPs across Miami-Dade, Broward, Palm Beach, Monroe. Data is local (instant). Use alongside Census for psychographic profiles.',
    input_schema: {
      type: 'object',
      properties: {
        zip_codes: { type: 'string', description: 'Comma-separated ZIP codes. Example: "33027,33028,33025".' }
      },
      required: ['zip_codes']
    }
  },
  {
    name: 'one_medical_location_lookup',
    description: 'Looks up One Medical (Amazon) primary care clinics in South Florida. 7 clinics, BH referral partner. Includes coordinates for drive-time analysis.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Filter by city name. Optional.' },
        county: { type: 'string', description: 'Filter by county. Optional.' }
      },
      required: []
    }
  },
  {
    name: 'generate_choropleth_map',
    description: 'Generates a ZIP code choropleth (heat map) for South Florida. Colors ZIP polygons by a chosen metric. Use when the user asks to "map," "show," "visualize," or "heat map" a metric across ZIPs or South Florida. Supports CDC health measures and demographic metrics. Returns top/bottom 5 ZIPs — the interactive map renders automatically in the UI.',
    input_schema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description: 'Metric code to map. CDC measures: ACCESS2, ARTHRITIS, BINGE, BPHIGH, CANCER, CASTHMA, CHD, CHECKUP, CHOLSCREEN, COPD, CSMOKING, DENTAL, DEPRESSION, DIABETES, DISABILITY, GHLTH, HIGHCHOL, LPA, MAMMOUSE, MHLTH, OBESITY, PHLTH, SLEEP, STROKE, TEETHLOST, VISION. Payer mix: COMMERCIAL_PCT, PUBLIC_INS_PCT, UNINSURED_PCT, PRIVATE_18_64_PCT, UNINS_18_64_PCT. Population: TOTAL_POP, MALE_PCT, FEMALE_PCT, MEDIAN_AGE, AGE_18_PLUS_PCT, AGE_65_PLUS_PCT, AGE_UNDER5_PCT through AGE_85_PLUS_PCT. Race/Language: HISPANIC_PCT, WHITE_PCT, BLACK_PCT, ASIAN_PCT, SPANISH_HOME_PCT. Income: MEDIAN_INCOME, MEAN_INCOME, PER_CAPITA_INCOME, POVERTY_PCT. Education: BACHELOR_PLUS_PCT. Housing: OWNER_OCCUPIED_PCT, RENTER_PCT, MEDIAN_HOME_VALUE. Other: DISABILITY_PCT, UNEMPLOYMENT_PCT, FOREIGN_BORN_PCT.'
        },
        label: {
          type: 'string',
          description: 'Human-readable label for the legend (e.g., "Diabetes Rate (%)", "Commercial Insurance %").'
        },
        zip_codes: {
          type: 'string',
          description: 'Optional. Comma-separated ZIPs to highlight. If omitted, maps all 195 South Florida ZIPs.'
        }
      },
      required: ['metric', 'label']
    }
  },
  {
    name: 'resolve_bh_facility',
    description: 'Instantly resolves a Baptist Health facility name to its address and coordinates from local cache. Use before geocoding — if the user mentions a BH facility by name, resolve it here first (free, instant) instead of searching Yext. Examples: "Homestead Hospital", "Baptist Hospital", "Doctors Hospital", "West Kendall".',
    input_schema: {
      type: 'object',
      properties: {
        facility_name: { type: 'string', description: 'Natural language facility name, e.g., "Homestead Hospital", "Baptist Hospital", "Doctors Hospital"' }
      },
      required: ['facility_name']
    }
  },
  {
    name: 'map_control',
    description: 'Controls the map display. Use to add/remove ZIP overlays, zoom to a facility, highlight locations, or modify the map based on user requests. Only call when the user asks to change the map view.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['show_zips', 'hide_zips', 'zoom_to', 'highlight', 'set_view', 'clear_highlights'], description: 'Map command to execute' },
        zips: { type: 'string', description: 'Comma-separated ZIP codes for show_zips command' },
        lat: { type: 'number', description: 'Latitude for zoom_to/set_view' },
        lng: { type: 'number', description: 'Longitude for zoom_to/set_view' },
        zoom: { type: 'number', description: 'Zoom level (10-18)' },
        label: { type: 'string', description: 'Label text for highlight command' }
      },
      required: ['command']
    }
  },
  {
    name: 'lookup_permits',
    description: 'Queries the persistent permit & construction tracker for healthcare projects in our 4-county Primary Service Area (Miami-Dade, Broward, Palm Beach, Monroe). Returns active permits, AHCA filings, and construction projects from the SQLite database. Use for Insight Miner newsletter Section 4, competitive intelligence, or any permit/construction question. Shows what is NEW and UPDATED since a given date.',
    input_schema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'Filter by county.', enum: ['Miami-Dade', 'Broward', 'Palm Beach', 'Monroe'] },
        health_system: { type: 'string', description: 'Filter by health system name (partial match). Examples: "HCA", "Cleveland Clinic", "Baptist Health", "Memorial".' },
        status: { type: 'string', description: 'Filter by permit status.', enum: ['new', 'application_filed', 'approved', 'under_construction', 'completed', 'denied', 'withdrawn'] },
        active_only: { type: 'boolean', description: 'If true (default), only return active projects. Set false to include completed/denied/withdrawn.' },
        since_date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Tags results as NEW/UPDATED/UNCHANGED relative to this date. Use for newsletter delta detection — pass the date of the previous issue.' },
        include_history: { type: 'boolean', description: 'If true, include status change history for each permit.' }
      },
      required: []
    }
  }
];

// ── Load Local Data ────────────────────────────────────────────────────────
const CDC_PLACES_PATH = path.join(__dirname, 'data', 'cdc-places-south-florida.json');
let cdcPlacesData = {};
try {
  cdcPlacesData = JSON.parse(fs.readFileSync(CDC_PLACES_PATH, 'utf8'));
  console.log(`  CDC PLACES: ${Object.keys(cdcPlacesData).length} ZIPs loaded`);
} catch (err) {
  console.warn('  CDC PLACES: data file not found');
}

const ONE_MEDICAL_PATH = path.join(__dirname, 'data', 'one-medical-locations.json');
let oneMedicalData = { locations: [], partnership: {} };
try {
  oneMedicalData = JSON.parse(fs.readFileSync(ONE_MEDICAL_PATH, 'utf8'));
  console.log(`  One Medical: ${oneMedicalData.locations.length} locations loaded`);
} catch (err) {
  console.warn('  One Medical: data file not found');
}

// ── ZCTA GeoJSON (ZIP boundaries for choropleth maps) ─────────────────────
const ZCTA_GEOJSON_PATH = path.join(__dirname, 'data', 'zcta-south-florida.geojson');
let zctaGeoJSON = null;
try {
  zctaGeoJSON = JSON.parse(fs.readFileSync(ZCTA_GEOJSON_PATH, 'utf8'));
  console.log(`  ZCTA GeoJSON: ${zctaGeoJSON.features?.length || 0} ZIP boundaries loaded`);
} catch (err) {
  console.warn('  ZCTA GeoJSON: not found — run "node scripts/build-zcta-geojson.js" to generate');
}

// ZIPs in CDC data but outside the 4-county PSA (Monroe, Miami-Dade, Broward, Palm Beach)
const PSA_EXCLUDED_ZIPS = new Set(['33440', '33455', '33458', '33469', '33471', '33478']);

// ── BH Facility Cache (Yext preload at startup, persisted to disk) ──────
const BH_CACHE_PATH = path.join(__dirname, 'data', 'bh-facility-cache.json');
let bhFacilityCache = [];

// Load from disk on cold start
try {
  bhFacilityCache = JSON.parse(fs.readFileSync(BH_CACHE_PATH, 'utf8'));
  console.log(`  BH Facilities: ${bhFacilityCache.length} loaded from disk cache`);
} catch (e) {
  console.log('  BH Facilities: no disk cache — will fetch from Yext');
}

async function refreshBHFacilityCache() {
  try {
    let allEntities = [];
    let offset = 0;
    const limit = 50;
    // Paginate to get ALL facilities (Yext max 50 per call)
    while (true) {
      const url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareFacility&limit=${limit}&offset=${offset}&fields=name,address,geocodedCoordinate,closed&filter=%7B%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D`;
      const res = await fetch(url);
      const data = await res.json();
      const entities = data.response?.entities || [];
      allEntities = allEntities.concat(entities);
      if (entities.length < limit) break; // No more pages
      offset += limit;
    }
    bhFacilityCache = allEntities;
    // Persist to disk
    fs.writeFileSync(BH_CACHE_PATH, JSON.stringify(allEntities, null, 2));
    console.log(`  BH Facilities: ${bhFacilityCache.length} cached from Yext (saved to disk)`);
  } catch (e) {
    console.warn('  BH Facilities: Yext refresh failed', e.message);
  }
}
// Refresh on startup (async, doesn't block), then every 6 hours
refreshBHFacilityCache();
setInterval(refreshBHFacilityCache, 6 * 60 * 60 * 1000);

function resolveBHFacility(query) {
  if (bhFacilityCache.length === 0) return null;
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter(w => w.length > 2);

  // Score each facility — higher = better match
  const scored = bhFacilityCache.map(e => {
    const name = (e.name || '').toLowerCase();
    const city = (e.address?.city || '').toLowerCase();
    let score = 0;
    // Count how many query words match name or city
    for (const w of words) {
      if (name.includes(w)) score += 2;
      else if (city.includes(w)) score += 1;
    }
    // Boost: if query says "hospital" and the facility IS the hospital (not a sub-facility with "(Hospital)" in parentheses)
    if (q.includes('hospital') && /baptist health.*hospital/i.test(e.name) && !/\(/.test(e.name)) score += 20;
    // Smaller boost for sub-facilities that reference the hospital campus
    if (q.includes('hospital') && name.includes('hospital') && /\(/.test(e.name)) score += 5;
    // Boost: exact facility type match (urgent care, imaging, etc.)
    if (q.includes('urgent') && name.includes('urgent') && !/\(/.test(e.name)) score += 20;
    if (q.includes('imaging') && name.includes('imaging') && !/\(/.test(e.name)) score += 20;
    if (q.includes('primary') && name.includes('primary') && !/\(/.test(e.name)) score += 20;
    // Penalty: if query says "hospital" but facility is NOT a hospital
    if (q.includes('hospital') && !name.includes('hospital')) score -= 5;
    return { entity: e, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].entity : null;
}

// ── Census Cache ───────────────────────────────────────────────────────────
// Census ACS data changes once a year. Cache successful responses to survive
// government API outages — a marketing lead can't wait for Census to come back up.
const CENSUS_CACHE_PATH = path.join(__dirname, 'data', 'census-cache.json');
let censusCache = {};
try {
  censusCache = JSON.parse(fs.readFileSync(CENSUS_CACHE_PATH, 'utf8'));
  console.log(`  Census cache: ${Object.keys(censusCache).length} cached queries loaded`);
} catch (err) {
  console.log('  Census cache: empty (will populate on first successful queries)');
}

function getCensusCache(cacheKey) {
  const entry = censusCache[cacheKey];
  if (!entry) return null;
  // Cache valid for 90 days (Census data is annual)
  const age = Date.now() - entry.timestamp;
  if (age > 90 * 24 * 60 * 60 * 1000) return null;
  return entry;
}

function setCensusCache(cacheKey, data, year) {
  censusCache[cacheKey] = { data, year, timestamp: Date.now() };
  // Write async — don't block the response
  fs.writeFile(CENSUS_CACHE_PATH, JSON.stringify(censusCache), () => {});
}

// ── CDC Benchmarks (percentiles across 195 South Florida ZIPs) ─────────────
function computeBenchmarks(cdcData) {
  const metrics = {};
  const zips = Object.keys(cdcData);
  if (zips.length < 10) return metrics;
  // CDC data is nested: cdcData[zip].measures.METRIC
  const sampleMeasures = cdcData[zips[0]]?.measures;
  if (!sampleMeasures || typeof sampleMeasures !== 'object') return metrics;
  for (const measure of Object.keys(sampleMeasures)) {
    const values = zips.map(z => parseFloat(cdcData[z]?.measures?.[measure]?.value)).filter(v => !isNaN(v)).sort((a, b) => a - b);
    if (values.length < 10) continue;
    metrics[measure] = {
      p10: values[Math.floor(values.length * 0.10)],
      p25: values[Math.floor(values.length * 0.25)],
      p50: values[Math.floor(values.length * 0.50)],
      p75: values[Math.floor(values.length * 0.75)],
      p90: values[Math.floor(values.length * 0.90)],
      p95: values[Math.floor(values.length * 0.95)],
    };
  }
  return metrics;
}
const CDC_BENCHMARKS = computeBenchmarks(cdcPlacesData);
const benchmarkKeys = ['CHECKUP', 'DENTAL', 'LPA', 'OBESITY', 'CSMOKING', 'DIABETES', 'BPHIGH', 'DEPRESSION', 'ACCESS2', 'MAMMOUSE'];
if (Object.keys(CDC_BENCHMARKS).length > 0) {
  console.log(`  CDC Benchmarks: ${Object.keys(CDC_BENCHMARKS).length} measures computed`);
  try { fs.writeFileSync(path.join(__dirname, 'data', 'zip-benchmarks.json'), JSON.stringify(CDC_BENCHMARKS, null, 2)); } catch (e) {}

  // Inject top benchmarks into reference prompt for agent context
  const bLines = ['\n\nSOUTH FLORIDA BENCHMARKS (195 ZIPs — use to flag outliers):'];
  for (const key of benchmarkKeys) {
    const b = CDC_BENCHMARKS[key];
    if (b) bLines.push(`  ${key}: p10=${b.p10}% | p25=${b.p25}% | p50=${b.p50}% | p75=${b.p75}% | p90=${b.p90}% | p95=${b.p95}%`);
  }
  bLines.push('\nWhen presenting CDC data, if a value falls in the top 10% (above p90) or bottom 10% (below p10) for South Florida, flag it:');
  bLines.push('> **Notable:** [metric] at [value]% is in the [top/bottom X%] of South Florida ZIPs.');
  REF_PROMPT += bLines.join('\n');
}

// ── Demographic Index (for choropleth maps) ───────────────────────────────
// Parse Census cache to build per-ZIP demographic metrics for instant choropleth rendering
const CENSUS_VAR_MAP = {
  // Payer mix
  'DP03_0096PE': 'INSURED_PCT',
  'DP03_0097E':  'COMMERCIAL_COUNT',    'DP03_0097PE': 'COMMERCIAL_PCT',
  'DP03_0098E':  'PUBLIC_INS_COUNT',    'DP03_0098PE': 'PUBLIC_INS_PCT',
  'DP03_0099E':  'UNINSURED_COUNT',     'DP03_0099PE': 'UNINSURED_PCT',
  'DP03_0101PE': 'INS_UNDER19_PCT',     'DP03_0102PE': 'UNINS_UNDER19_PCT',
  'DP03_0104PE': 'PRIVATE_18_64_PCT',   'DP03_0105PE': 'PUBLIC_18_64_PCT',
  'DP03_0106PE': 'UNINS_18_64_PCT',
  'S2704_C02_002E': 'MEDICARE_COUNT',   'S2704_C02_003E': 'EMPLOYER_INS_COUNT',
  'S2704_C02_004E': 'DIRECT_PURCHASE_COUNT', 'S2704_C02_006E': 'MEDICAID_COUNT',
  // Population & sex
  'DP05_0001E': 'TOTAL_POP',
  'DP05_0002E': 'MALE_COUNT',           'DP05_0002PE': 'MALE_PCT',
  'DP05_0003E': 'FEMALE_COUNT',         'DP05_0003PE': 'FEMALE_PCT',
  // Age brackets (counts)
  'DP05_0005E': 'AGE_UNDER5',           'DP05_0006E': 'AGE_5_9',
  'DP05_0007E': 'AGE_10_14',            'DP05_0008E': 'AGE_15_19',
  'DP05_0009E': 'AGE_20_24',            'DP05_0010E': 'AGE_25_34',
  'DP05_0011E': 'AGE_35_44',            'DP05_0012E': 'AGE_45_54',
  'DP05_0013E': 'AGE_55_59',            'DP05_0014E': 'AGE_60_64',
  'DP05_0015E': 'AGE_65_74',            'DP05_0016E': 'AGE_75_84',
  'DP05_0017E': 'AGE_85_PLUS',
  // Age bracket percentages
  'DP05_0005PE': 'AGE_UNDER5_PCT',      'DP05_0006PE': 'AGE_5_9_PCT',
  'DP05_0007PE': 'AGE_10_14_PCT',       'DP05_0008PE': 'AGE_15_19_PCT',
  'DP05_0009PE': 'AGE_20_24_PCT',       'DP05_0010PE': 'AGE_25_34_PCT',
  'DP05_0011PE': 'AGE_35_44_PCT',       'DP05_0012PE': 'AGE_45_54_PCT',
  'DP05_0013PE': 'AGE_55_59_PCT',       'DP05_0014PE': 'AGE_60_64_PCT',
  'DP05_0015PE': 'AGE_65_74_PCT',       'DP05_0016PE': 'AGE_75_84_PCT',
  'DP05_0017PE': 'AGE_85_PLUS_PCT',
  // Key age groups
  'DP05_0018E': 'MEDIAN_AGE',
  'DP05_0021E': 'AGE_18_PLUS',          'DP05_0021PE': 'AGE_18_PLUS_PCT',
  'DP05_0024E': 'AGE_65_PLUS',          'DP05_0024PE': 'AGE_65_PLUS_PCT',
  // Race & ethnicity
  'DP05_0071E': 'HISPANIC_COUNT',       'DP05_0071PE': 'HISPANIC_PCT',
  'DP05_0077PE': 'WHITE_PCT',           'DP05_0078PE': 'BLACK_PCT',
  'DP05_0080PE': 'ASIAN_PCT',           'DP05_0082PE': 'TWO_PLUS_RACES_PCT',
  // Language
  'DP02_0113PE': 'OTHER_LANG_HOME_PCT', 'DP02_0116PE': 'SPANISH_HOME_PCT',
  // Income
  'DP03_0062E': 'MEDIAN_INCOME',        'DP03_0063E': 'MEAN_INCOME',
  'DP03_0088E': 'PER_CAPITA_INCOME',
  // Education
  'DP02_0067PE': 'SOME_COLLEGE_PCT',    'DP02_0068PE': 'BACHELOR_PLUS_PCT',
  // Employment
  'DP03_0004PE': 'EMPLOYMENT_RATE',     'DP03_0005PE': 'UNEMPLOYMENT_PCT',
  // Poverty
  'DP03_0119PE': 'POVERTY_PCT',
  // Housing
  'DP02_0001E': 'HOUSEHOLDS',           'DP02_0002E': 'FAMILIES',
  'DP04_0046PE': 'OWNER_OCCUPIED_PCT',  'DP04_0047PE': 'RENTER_PCT',
  'DP04_0089E': 'MEDIAN_HOME_VALUE',    'DP04_0134E': 'MEDIAN_RENT',
  // Other
  'DP02_0072PE': 'DISABILITY_PCT',      'DP02_0071E': 'VETERANS',
  'DP02_0096PE': 'FOREIGN_BORN_PCT',
  'DP04_0058PE': 'NO_VEHICLE_PCT',      'DP02_0153PE': 'INTERNET_PCT',
};

function buildDemographicIndex(cache) {
  const index = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.data || !Array.isArray(entry.data) || entry.data.length < 2) continue;
    const headers = entry.data[0];
    for (let i = 1; i < entry.data.length; i++) {
      const row = entry.data[i];
      const zipIdx = headers.indexOf('zip code tabulation area');
      if (zipIdx === -1) continue;
      const zip = row[zipIdx];
      if (!zip || !cdcPlacesData[zip]) continue; // only our 195 ZIPs
      if (!index[zip]) index[zip] = {};
      for (let j = 0; j < headers.length; j++) {
        const metricName = CENSUS_VAR_MAP[headers[j]];
        if (!metricName) continue;
        const v = parseFloat(row[j]);
        if (!isNaN(v)) index[zip][metricName] = v;
      }
    }
  }
  return index;
}
const demographicIndex = buildDemographicIndex(censusCache);
console.log(`  Demographic index: ${Object.keys(demographicIndex).length} ZIPs with Census metrics`);

// ── Tool Executors ──────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function truncateResult(data, maxChars = 50000) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  if (str.length <= maxChars) return data;
  return str.substring(0, maxChars) + '\n\n[... truncated — ' + str.length + ' total chars]';
}

// ── Haversine Distance (miles) ──────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Point-in-Polygon (ray casting) ────────────────────────────────────────
// Used to filter map pins to only those inside an isochrone polygon
function pointInPolygon(lat, lng, polygon) {
  // polygon is an array of [lng, lat] coordinate rings
  let inside = false;
  for (let ring = 0; ring < polygon.length; ring++) {
    const coords = polygon[ring];
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i][1], yi = coords[i][0]; // [lng, lat] → lat, lng
      const xj = coords[j][1], yj = coords[j][0];
      if (((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function pointInIsochrone(lat, lng, isochrone) {
  if (!isochrone?.features) return false;
  for (const feature of isochrone.features) {
    const geom = feature.geometry;
    if (geom.type === 'Polygon') {
      if (pointInPolygon(lat, lng, geom.coordinates)) return true;
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (pointInPolygon(lat, lng, poly)) return true;
      }
    }
  }
  return false;
}

// ── ENVELOPE: structured status, warnings, metadata ────────────────────────
function envelope(api, url, timestamp, data, opts = {}) {
  const isArray = Array.isArray(data);
  const count = isArray ? data.length : (data?.error ? 0 : (data?.locations ? data.locations.length : 1));
  const truncated = JSON.stringify(data || '').includes('[... truncated');
  const status = data?.error ? 'failed'
    : (count === 0 ? 'empty'
    : (truncated ? 'partial' : 'success'));
  return {
    _source: { api, url, retrieved_at: timestamp },
    status,
    result_count: count,
    warnings: opts.warnings || [],
    query: opts.query || null,
    data_year: opts.data_year || null,
    filtering: opts.filtering || null,
    data: truncateResult(data),
    _rawData: data  // Preserve original for geo accumulation (not sent to model)
  };
}

function compressToolResult(toolName, fullContent) {
  const MAX_SUMMARY = 2000;
  try {
    const parsed = JSON.parse(fullContent);
    const data = parsed.data || parsed;
    if (Array.isArray(data)) {
      return JSON.stringify({
        _compressed: true, tool: toolName, status: parsed.status,
        total_records: data.length, sample: data.slice(0, 3),
        note: `Full data had ${data.length} records. Compressed for session context.`
      }).substring(0, MAX_SUMMARY);
    }
    if (data && typeof data === 'object') {
      if (data.error) return JSON.stringify({ _compressed: true, tool: toolName, status: 'failed', error: data.error });
      const keys = Object.keys(data);
      return JSON.stringify({
        _compressed: true, tool: toolName, status: parsed.status,
        keys: keys.slice(0, 10), preview: JSON.stringify(data).substring(0, 500),
        note: 'Compressed. Full data processed in prior turn.'
      }).substring(0, MAX_SUMMARY);
    }
    if (typeof data === 'string') {
      return JSON.stringify({
        _compressed: true, tool: toolName, status: parsed.status,
        preview: data.substring(0, 1500), full_length: data.length
      });
    }
  } catch (e) {}
  return fullContent.substring(0, MAX_SUMMARY);
}

async function executeTool(name, input) {
  const timestamp = new Date().toISOString();
  let url, res, data, source;

  try {
    switch (name) {

      case 'baptist_health_location_lookup': {
        const isBroadSearch = input.filter === '%7B%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D';
        let entities, filterMeta = null;

        if (isBroadSearch && bhFacilityCache.length > 0) {
          // Serve from cache — zero API cost
          entities = [...bhFacilityCache];
          source = 'BH Facility Cache (local)';
        } else {
          url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareFacility&limit=50&fields=name,address,geocodedCoordinate,closed&filter=${input.filter}`;
          source = url.replace(process.env.YEXT_API_KEY, '[KEY]');
          res = await fetchWithTimeout(url);
          data = await res.json();
          entities = data.response?.entities || [];
        }

        // Distance pre-filter: if we have origin coords, keep only nearby results
        if (executeTool._originCoords && entities.length > 5) {
          const maxMiles = 25;
          const before = entities.length;
          // Add distance to each entity for sorting
          entities = entities.map(e => {
            const lat = e.geocodedCoordinate?.latitude;
            const lon = e.geocodedCoordinate?.longitude;
            e._distMiles = (lat && lon) ? haversineDistance(executeTool._originCoords.lat, executeTool._originCoords.lng, lat, lon) : 999;
            return e;
          }).filter(e => e._distMiles <= maxMiles);
          // Sort by distance
          entities.sort((a, b) => a._distMiles - b._distMiles);
          filterMeta = { origin: executeTool._originCoords, maxMiles, before, after: entities.length, omitted: before - entities.length };
        }
        // Even without origin, cap at 25 to reduce token bloat
        else if (entities.length > 25) {
          const before = entities.length;
          entities = entities.slice(0, 25);
          filterMeta = { capped: true, before, after: 25, note: 'No origin coords — capped at 25 results' };
        }

        return envelope('Yext Live API', source, timestamp, entities, {
          query: { filter: input.filter },
          filtering: filterMeta
        });
      }

      case 'census_demographics_lookup': {
        const warnings = [];
        const cacheKey = input.endpoint;
        const years = [input.year || '2024', '2023'];
        let usedYear = null;

        // Try live API first (20s timeout — fail fast, don't make user wait 60s)
        for (const year of years) {
          url = `https://api.census.gov/data/${year}/acs/acs5${input.endpoint}${input.endpoint.includes('?') ? '&' : '?'}key=${process.env.CENSUS_API_KEY}`;
          source = url.replace(process.env.CENSUS_API_KEY, '[KEY]');
          try {
            res = await fetchWithTimeout(url, {}, 20000);
            if (res.ok) {
              data = await res.json();
              usedYear = year;
              if (year !== years[0]) warnings.push(warn('medium', 'CENSUS_FALLBACK', `Fell back from ${years[0]} to ${year} (${years[0]} data unavailable)`));
              // Cache successful result
              setCensusCache(cacheKey, data, year);
              break;
            }
            console.log(`[Census] ${year} returned ${res.status}, trying fallback...`);
          } catch (err) {
            console.log(`[Census] ${year} failed: ${err.message}, trying fallback...`);
          }
          if (year === years[0] && years[0] === '2023') break;
        }

        // If API failed, try cache
        if (!data) {
          const cached = getCensusCache(cacheKey);
          if (cached) {
            data = cached.data;
            usedYear = cached.year;
            const ageDays = Math.round((Date.now() - cached.timestamp) / (24 * 60 * 60 * 1000));
            warnings.push(warn(ageDays > 60 ? 'medium' : 'low', 'CENSUS_CACHED', `Census API unavailable — serving cached data from ${ageDays} day(s) ago (${cached.year} dataset)`));
            console.log(`[Census] API down — served from cache (${ageDays}d old)`);
          }
        }

        if (!data) {
          return envelope('Census ACS 5-Year', source, timestamp,
            { error: 'Census Bureau API is currently unavailable and no cached data exists for this query. Try again in a few minutes.' },
            { query: { endpoint: input.endpoint } }
          );
        }

        // Server-side percentage calculation for B01001 age/sex variables
        if (Array.isArray(data) && data.length > 1) {
          const headers = data[0];
          const totalIdx = headers.indexOf('B01001_001E');
          if (totalIdx !== -1) {
            const newHeaders = [...headers];
            const pctCols = [];
            for (let i = 0; i < headers.length; i++) {
              if (headers[i].match(/^B01001_\d+E$/) && headers[i] !== 'B01001_001E') {
                newHeaders.push(headers[i].replace(/E$/, '_PCT'));
                pctCols.push({ srcIdx: i, totalIdx });
              }
            }
            if (pctCols.length > 0) {
              data[0] = newHeaders;
              for (let r = 1; r < data.length; r++) {
                const total = parseFloat(data[r][totalIdx]) || 1;
                for (const col of pctCols) {
                  const val = parseFloat(data[r][col.srcIdx]) || 0;
                  data[r].push((val / total * 100).toFixed(1));
                }
              }
              warnings.push('Server computed _PCT columns from B01001 raw counts (denominator: B01001_001E total population)');
            }
          }
        }

        return envelope(`Census ACS 5-Year (${usedYear})`, source, timestamp, data, {
          data_year: usedYear,
          warnings,
          query: { endpoint: input.endpoint, year_used: usedYear }
        });
      }

      case 'web_research': {
        url = 'https://api.firecrawl.dev/v1/search';
        source = 'Firecrawl Web Search';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}` },
          body: JSON.stringify({
            query: input.research_query,
            limit: 5
          })
        }, 60000);
        data = await res.json();
        if (!data.success) {
          return envelope(source, url, timestamp, { error: data.error || 'Firecrawl search failed' }, {
            query: { research_query: input.research_query }
          });
        }
        const results = (data.data || []).map(r => ({
          title: r.title || '',
          url: r.url || '',
          description: r.description || ''
        }));
        return envelope(source, 'firecrawl.dev/v1/search', timestamp, results, {
          query: { research_query: input.research_query },
          result_count: results.length
        });
      }

      case 'read_page': {
        const targetUrl = input.url;
        source = 'Jina Reader';

        // Step 1: Try Jina Reader (free, no API key)
        try {
          res = await fetchWithTimeout(`https://r.jina.ai/${targetUrl}`, {
            method: 'GET',
            headers: { 'Accept': 'text/plain' }
          }, 30000);
          const markdown = await res.text();

          // If Jina returned meaningful content (>200 chars), use it
          if (markdown && markdown.length > 200) {
            return envelope(source, `r.jina.ai/${targetUrl}`, timestamp, {
              url: targetUrl,
              content: markdown.slice(0, 50000)
            }, { extractor: 'jina', content_length: markdown.length });
          }
        } catch (e) {
          // Jina failed — fall through to Firecrawl
        }

        // Step 2: Fallback to Firecrawl /scrape (handles JS-rendered pages)
        source = 'Firecrawl Scrape (fallback)';
        res = await fetchWithTimeout('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`
          },
          body: JSON.stringify({
            url: targetUrl,
            formats: ['markdown'],
            onlyMainContent: true
          })
        }, 60000);
        data = await res.json();
        if (!data.success) {
          return envelope(source, targetUrl, timestamp, {
            error: data.error || 'Firecrawl scrape failed'
          }, { extractor: 'firecrawl_fallback' });
        }
        return envelope(source, targetUrl, timestamp, {
          url: targetUrl,
          content: (data.data?.markdown || '').slice(0, 50000)
        }, { extractor: 'firecrawl_fallback', content_length: data.data?.markdown?.length || 0 });
      }

      case 'resolve_bh_facility': {
        const match = resolveBHFacility(input.facility_name);
        if (match && match.geocodedCoordinate) {
          executeTool._originCoords = { lat: match.geocodedCoordinate.latitude, lng: match.geocodedCoordinate.longitude };
          return envelope('BH Facility Cache', 'local', timestamp, {
            name: match.name,
            address: match.address ? `${match.address.line1}, ${match.address.city}, ${match.address.region} ${match.address.postalCode}` : '',
            lat: match.geocodedCoordinate.latitude,
            lng: match.geocodedCoordinate.longitude
          }, { cached: true });
        }
        return envelope('BH Facility Cache', 'local', timestamp, { error: `No matching facility found for "${input.facility_name}"` }, { cached: true });
      }

      case 'map_control': {
        return envelope('Map Control', 'local', timestamp, { command: input.command, ...input }, { cached: true, _mapCommand: true });
      }

      case 'geocode_address': {
        // Normalize city aliases in the address
        let address = input.address;
        for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
          const encoded = alias.replace(/ /g, '+');
          if (address.toLowerCase().includes(encoded)) {
            address = address.replace(new RegExp(encoded, 'gi'), canonical.replace(/ /g, '+'));
            break;
          }
        }

        url = `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.GOOGLE_MAPS_API_KEY}&address=${address}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();

        // Server-side city verification
        const warnings = [];
        const inputCity = decodeURIComponent(address.replace(/\+/g, ' '))
          .match(/([A-Za-z\s]+),?\s*FL/i)?.[1]?.trim().toLowerCase();
        if (inputCity && data.results?.[0]) {
          const geoCity = data.results[0].address_components
            ?.find(c => c.types.includes('locality'))?.long_name?.toLowerCase();
          if (geoCity && geoCity !== inputCity && !geoCity.includes(inputCity) && !inputCity.includes(geoCity)) {
            warnings.push(warn('high', 'CITY_MISMATCH',
              `Input city "${inputCity}" but Google geocoded to "${geoCity}". Verify coordinates or re-geocode with exact city name.`));
          }
        }

        // Store origin coords for distance pre-filtering in subsequent tool calls
        if (data.results?.[0]?.geometry?.location) {
          const loc = data.results[0].geometry.location;
          // Attach to executeTool context for this session
          executeTool._originCoords = { lat: loc.lat, lng: loc.lng };
          console.log(`[Geocode] Origin stored: ${loc.lat}, ${loc.lng}`);
        }

        return envelope('Google Geocoding API', source, timestamp, data.results || data, {
          warnings,
          query: { address: input.address }
        });
      }

      case 'calculate_drive_times': {
        url = `https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}&origins=${input.origins}&destinations=${input.destinations}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        // Flatten into unambiguous origin→destination pairs
        const flat = [];
        const warnings = [];
        const origins = data.origin_addresses || [];
        const dests = data.destination_addresses || [];
        for (let oi = 0; oi < (data.rows || []).length; oi++) {
          for (let di = 0; di < (data.rows[oi].elements || []).length; di++) {
            const el = data.rows[oi].elements[di];
            if (el.status !== 'OK') {
              warnings.push(`Route failed: ${origins[oi] || `origin_${oi}`} → ${dests[di] || `dest_${di}`} (status: ${el.status})`);
            }
            flat.push({
              origin: origins[oi] || `origin_${oi}`,
              destination: dests[di] || `dest_${di}`,
              status: el.status,
              duration: el.duration?.text || null,
              duration_seconds: el.duration?.value || null,
              distance: el.distance?.text || null,
              distance_meters: el.distance?.value || null
            });
          }
        }
        return envelope('Google Distance Matrix API', source, timestamp, flat, {
          warnings,
          query: { origins: input.origins, destinations: input.destinations }
        });
      }

      case 'competitor_ratings_reviews': {
        url = `https://maps.googleapis.com/maps/api/place/textsearch/json?key=${process.env.GOOGLE_MAPS_API_KEY}&query=${input.query}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        let places = data.results || [];
        let placesFilter = null;
        // Trim to top 10 by relevance (rating × review count) to reduce token bloat
        if (places.length > 10) {
          const before = places.length;
          places.sort((a, b) => (b.rating || 0) * (b.user_ratings_total || 0) - (a.rating || 0) * (a.user_ratings_total || 0));
          places = places.slice(0, 10);
          placesFilter = { before, after: 10, omitted: before - 10, rule: 'top 10 by rating × review count' };
        }
        return envelope('Google Places Text Search', source, timestamp, places, {
          query: { search_query: input.query },
          filtering: placesFilter
        });
      }

      case 'google_reviews_deep_pull': {
        let reviewUrl = `https://api.app.outscraper.com/maps/reviews-v3?sort=newest&language=en&async=false&reviewsLimit=${input.reviewsLimit}&query=${input.query}`;
        if (input.cutoff) reviewUrl += `&cutoff=${input.cutoff}`;
        url = reviewUrl;
        source = 'Outscraper Maps Reviews API';
        res = await fetchWithTimeout(url, {
          headers: { 'X-API-Key': process.env.OUTSCRAPER_API_KEY }
        }, 90000);
        data = await res.json();
        return envelope(source, url.replace(process.env.OUTSCRAPER_API_KEY, '[KEY]'), timestamp, data, {
          query: { location: input.query, reviewsLimit: input.reviewsLimit }
        });
      }

      case 'drive_time_isochrone': {
        // Smart coordinate handling: accept address, lat/lng, or legacy [lng,lat] format
        let isoLat, isoLng;

        if (input.address) {
          // Geocode the address
          const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input.address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
          const geoRes = await fetchWithTimeout(geoUrl);
          const geoData = await geoRes.json();
          if (geoData.results?.[0]?.geometry?.location) {
            isoLat = geoData.results[0].geometry.location.lat;
            isoLng = geoData.results[0].geometry.location.lng;
            // Store origin so map filtering and Yext distance pre-filter work
            executeTool._originCoords = { lat: isoLat, lng: isoLng };
            console.log(`[Isochrone] Geocoded "${input.address}" → ${isoLat}, ${isoLng}`);
            console.log(`[Geocode] Origin stored: ${isoLat}, ${isoLng}`);
          } else {
            return envelope('Isochrone', 'geocode-failed', timestamp, { error: `Could not geocode: ${input.address}` });
          }
        } else if (input.lat != null && input.lng != null) {
          isoLat = input.lat;
          isoLng = input.lng;
          executeTool._originCoords = { lat: isoLat, lng: isoLng };
          isoLng = input.lng;
        } else if (input.locations?.[0]) {
          // Legacy format: [[lng, lat]] — accept it but normalize
          isoLng = input.locations[0][0];
          isoLat = input.locations[0][1];
          // Detect if agent swapped lat/lng (lat should be 24-27 for South Florida)
          if (isoLat < -70 && isoLng > 20 && isoLng < 30) {
            console.log(`[Isochrone] Detected swapped coordinates, fixing: [${isoLng}, ${isoLat}] → [${isoLat}, ${isoLng}]`);
            [isoLat, isoLng] = [isoLng, isoLat];
          }
        } else if (executeTool._originCoords) {
          // Fall back to previously geocoded origin
          isoLat = executeTool._originCoords.lat;
          isoLng = executeTool._originCoords.lng;
          console.log(`[Isochrone] Using stored origin: ${isoLat}, ${isoLng}`);
        } else {
          return envelope('Isochrone', 'no-location', timestamp, { error: 'No location provided. Pass address, lat/lng, or geocode first.' });
        }

        // ORS requires [longitude, latitude] — server handles the swap
        const orsLocations = [[isoLng, isoLat]];
        url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
        source = 'OpenRouteService Isochrone API';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': process.env.ORS_API_KEY },
          body: JSON.stringify({ locations: orsLocations, range: input.range, range_type: 'time' })
        });
        data = await res.json();
        return envelope(source, url, timestamp, data, {
          query: { lat: isoLat, lng: isoLng, range: input.range }
        });
      }

      case 'baptist_health_physician_lookup': {
        const warnings = [];
        let filter = input.filter;
        const decoded = decodeURIComponent(filter.replace(/\+/g, ' '));

        // Check for array synonyms (e.g., "primary care" → ["Internal Medicine", "Family Medicine"])
        let multiSearch = null;
        for (const [colloquial, canonical] of Object.entries(SPECIALTY_SYNONYMS)) {
          if (decoded.toLowerCase().includes(`"${colloquial}"`)) {
            if (Array.isArray(canonical)) {
              multiSearch = canonical;
              warnings.push(warn('low', 'SYNONYM_MULTI', `Mapped "${colloquial}" → searching both: ${canonical.join(' + ')}`));
            } else {
              filter = encodeURIComponent(decoded.replace(new RegExp(`"${colloquial}"`, 'gi'), `"${canonical}"`)).replace(/%20/g, '+');
              warnings.push(warn('low', 'SYNONYM_MAPPED', `Mapped specialty synonym: "${colloquial}" → "${canonical}"`));
            }
            break;
          }
        }

        // Normalize city aliases in the filter
        const filterDecoded = multiSearch ? decoded : decodeURIComponent(filter.replace(/\+/g, ' '));
        for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
          if (filterDecoded.toLowerCase().includes(`"${alias}"`)) {
            if (!multiSearch) {
              filter = encodeURIComponent(filterDecoded.replace(new RegExp(`"${alias}"`, 'gi'), `"${canonical}"`)).replace(/%20/g, '+');
            }
            warnings.push(warn('low', 'CITY_NORMALIZED', `Normalized city: "${alias}" → "${canonical}"`));
            break;
          }
        }

        // If array synonym, run multiple searches and merge (dedupe by entity ID)
        if (multiSearch) {
          let allPhysicians = [];
          const seenIds = new Set();
          for (const specialty of multiSearch) {
            const thisFilter = encodeURIComponent(decoded.replace(new RegExp(`"[^"]*"`, 'i'), `"${specialty}"`)).replace(/%20/g, '+');
            const thisUrl = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareProfessional&limit=50&fields=name,c_listOfSpecialties,c_providerTitle,degrees,address,geocodedCoordinate,mainPhone,languages,npi,acceptingNewPatients,c_averageReviewRating,c_reviewCount,officeName,closed&filter=${thisFilter}`;
            const thisRes = await fetchWithTimeout(thisUrl);
            const thisData = await thisRes.json();
            for (const ent of (thisData.response?.entities || [])) {
              const id = ent.meta?.id || ent.npi || ent.name;
              if (!seenIds.has(id)) { seenIds.add(id); allPhysicians.push(ent); }
            }
          }
          source = 'Yext Live API (Physicians) — multi-specialty merge';
          return envelope(source, '[multi-search]', timestamp, allPhysicians, {
            warnings,
            query: { filter: input.filter, searched_specialties: multiSearch }
          });
        }

        url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareProfessional&limit=50&fields=name,c_listOfSpecialties,c_providerTitle,degrees,address,geocodedCoordinate,mainPhone,languages,npi,acceptingNewPatients,c_averageReviewRating,c_reviewCount,officeName,closed&filter=${filter}`;
        source = url.replace(process.env.YEXT_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        const physicians = data.response?.entities || [];
        return envelope('Yext Live API (Physicians)', source, timestamp, physicians, {
          warnings,
          query: { filter: input.filter }
        });
      }

      case 'cdc_health_behaviors': {
        const zips = input.zip_codes.split(',').map(z => z.trim());
        const results = {};
        const warnings = [];
        for (const zip of zips) {
          if (cdcPlacesData[zip]) {
            results[zip] = cdcPlacesData[zip];
          } else {
            results[zip] = { error: `No CDC PLACES data for ZIP ${zip}` };
            warnings.push(`ZIP ${zip} not in CDC PLACES coverage (195 South Florida ZIPs)`);
          }
        }
        return envelope('CDC PLACES 2025 (local data, BRFSS 2023)', 'cdc-places-south-florida.json', timestamp, results, {
          warnings,
          query: { zip_codes: input.zip_codes }
        });
      }

      case 'one_medical_location_lookup': {
        let results = oneMedicalData.locations.filter(l => l.status === 'open');
        if (input.city) {
          const city = normalizeCity(input.city);
          results = results.filter(l => l.city.toLowerCase().includes(city.toLowerCase()));
        }
        if (input.county) results = results.filter(l => l.county.toLowerCase().includes(input.county.toLowerCase()));
        return envelope('One Medical Locations (local data)', 'one-medical-locations.json', timestamp, {
          locations: results, total: results.length, partnership: oneMedicalData.partnership
        }, { query: { city: input.city, county: input.county } });
      }

      case 'generate_choropleth_map': {
        const metric = input.metric;
        const targetZips = input.zip_codes
          ? input.zip_codes.split(',').map(z => z.trim())
          : Object.keys(cdcPlacesData).filter(z => !PSA_EXCLUDED_ZIPS.has(z));

        const zipData = {};
        const values = [];
        const allDemoMetrics = new Set(Object.values(CENSUS_VAR_MAP));
        const isCDC = !allDemoMetrics.has(metric);

        for (const zip of targetZips) {
          let val = null;
          if (isCDC) {
            val = parseFloat(cdcPlacesData[zip]?.measures?.[metric]?.value);
            const entry = cdcPlacesData[zip]?.measures?.[metric];
            if (!isNaN(val)) {
              zipData[zip] = { value: val };
              if (entry?.ci_low != null) zipData[zip].ci_low = parseFloat(entry.ci_low);
              if (entry?.ci_high != null) zipData[zip].ci_high = parseFloat(entry.ci_high);
              values.push(val);
            }
          } else {
            val = demographicIndex[zip]?.[metric];
            if (val != null && !isNaN(val)) {
              zipData[zip] = { value: val };
              values.push(val);
            }
          }
        }

        if (values.length === 0) {
          return envelope('Choropleth Map', 'local', timestamp, { error: `No data found for metric "${metric}"` });
        }

        values.sort((a, b) => a - b);
        const min = values[0];
        const max = values[values.length - 1];

        // Compute quantile breaks (5 levels)
        const breaks = [
          values[Math.floor(values.length * 0.2)],
          values[Math.floor(values.length * 0.4)],
          values[Math.floor(values.length * 0.6)],
          values[Math.floor(values.length * 0.8)]
        ];

        // Get benchmarks if CDC metric
        const benchmarks = isCDC && CDC_BENCHMARKS[metric] ? CDC_BENCHMARKS[metric] : null;

        // Top 5 and bottom 5 for the agent summary
        const sorted = Object.entries(zipData).sort((a, b) => b[1].value - a[1].value);
        const top5 = sorted.slice(0, 5).map(([zip, d]) => ({ zip, value: d.value }));
        const bottom5 = sorted.slice(-5).reverse().map(([zip, d]) => ({ zip, value: d.value }));

        // Store choropleth payload for SSE emission (handled by accumulator)
        const choroplethPayload = {
          metric, label: input.label,
          domain: [min, max], breaks, benchmarks,
          zipData
        };

        // Attach to the result so accumulateChoropleth can pick it up
        const result = envelope('Choropleth Map', 'local', timestamp, {
          metric, label: input.label,
          zip_count: Object.keys(zipData).length,
          domain: [min, max], top5, bottom5,
          note: 'Interactive heat map rendered in UI. Summarize the geographic patterns you see in the top/bottom ZIPs.'
        });
        result._choropleth = choroplethPayload;
        return result;
      }

      case 'lookup_permits': {
        const { db: permitDb } = require('./db');
        let where = [];
        let params = [];

        if (input.county) { where.push('county = ?'); params.push(input.county); }
        if (input.health_system) { where.push('health_system LIKE ?'); params.push(`%${input.health_system}%`); }
        if (input.status) { where.push('status = ?'); params.push(input.status); }
        if (input.active_only !== false) { where.push('is_active = 1'); }
        if (input.since_date) {
          where.push('(first_seen_date >= ? OR last_status_change_date >= ?)');
          params.push(input.since_date, input.since_date);
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const permits = permitDb.prepare(
          `SELECT * FROM permits ${whereClause} ORDER BY last_status_change_date DESC, first_seen_date DESC`
        ).all(...params);

        const sinceDate = input.since_date || '1970-01-01';
        for (const p of permits) {
          if (p.first_seen_date >= sinceDate) {
            p._delta = 'NEW';
          } else if (p.last_status_change_date && p.last_status_change_date >= sinceDate) {
            p._delta = 'UPDATED';
          } else {
            p._delta = 'UNCHANGED';
          }
        }

        if (input.include_history) {
          const histStmt = permitDb.prepare('SELECT * FROM permit_history WHERE permit_id = ? ORDER BY changed_date DESC');
          for (const p of permits) {
            p._history = histStmt.all(p.permit_id);
          }
        }

        const summary = {
          total: permits.length,
          new: permits.filter(p => p._delta === 'NEW').length,
          updated: permits.filter(p => p._delta === 'UPDATED').length,
          by_county: {},
          by_system: {}
        };
        for (const p of permits) {
          summary.by_county[p.county] = (summary.by_county[p.county] || 0) + 1;
          if (p.health_system) summary.by_system[p.health_system] = (summary.by_system[p.health_system] || 0) + 1;
        }

        return envelope('MRA Permit Tracker', 'mra-ledger.db/permits', timestamp,
          { summary, permits },
          { query: { county: input.county, health_system: input.health_system, status: input.status, since_date: input.since_date } }
        );
      }

      default:
        return envelope('Unknown', 'N/A', timestamp, { error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`[Tool:${name}] Error:`, err.message);
    return envelope(name, url || 'N/A', timestamp, { error: err.message }, {
      query: input
    });
  }
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], lastAccess: Date.now(), knownEntities: { bhLocations: [], competitors: [], origins: [] } });
  }
  const session = sessions.get(sessionId);
  session.lastAccess = Date.now();
  return session;
}

function trimSession(session) {
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Human-readable label for tool progress timeline
function humanizeToolCall(toolName, input) {
  const labels = {
    'geocode_address': 'Geocoding address',
    'calculate_drive_times': 'Calculating drive times',
    'census_demographics_lookup': 'Pulling Census demographics',
    'cdc_health_behaviors': 'Loading CDC health behaviors',
    'web_research': 'Searching the web',
    'read_page': 'Reading page content',
    'drive_time_isochrone': 'Generating drive-time polygon',
    'google_reviews_deep_pull': 'Pulling Google reviews',
    'one_medical_location_lookup': 'Checking One Medical locations',
    'generate_choropleth_map': 'Generating heat map',
    'resolve_bh_facility': 'Resolving facility',
    'map_control': 'Updating map',
  };
  if (labels[toolName]) return labels[toolName];
  if (toolName === 'baptist_health_location_lookup') {
    const decoded = decodeURIComponent((input.filter || '').replace(/\+/g, ' '));
    const match = decoded.match(/\$contains[^"]*"([^"]+)"/);
    return match ? `Searching BH ${match[1]} locations` : 'Searching BH locations';
  }
  if (toolName === 'baptist_health_physician_lookup') {
    const decoded = decodeURIComponent((input.filter || '').replace(/\+/g, ' '));
    const specMatch = decoded.match(/listOfSpecialties[^"]*"([^"]+)"/);
    const cityMatch = decoded.match(/city[^"]*"([^"]+)"/);
    let label = 'Searching BH physicians';
    if (specMatch) label += ` — ${specMatch[1]}`;
    if (cityMatch) label += ` in ${cityMatch[1]}`;
    return label;
  }
  if (toolName === 'competitor_ratings_reviews') {
    const decoded = decodeURIComponent((input.query || '').replace(/\+/g, ' '));
    return `Searching competitors: ${decoded.substring(0, 50)}`;
  }
  return toolName.replace(/_/g, ' ');
}

// Accumulate geo data from tool results for map rendering
function accumulateGeoData(geo, toolName, result, session) {
  try {
    const data = result._rawData || result.data;  // Use raw (pre-truncation) data for geo
    if (toolName === 'geocode_address' && Array.isArray(data) && data[0]?.geometry?.location) {
      const loc = data[0].geometry.location;
      geo.origin = { lat: loc.lat, lng: loc.lng, label: data[0].formatted_address || 'Origin' };
      if (session?.knownEntities) {
        session.knownEntities.origins.push({ lat: loc.lat, lng: loc.lng, label: data[0].formatted_address });
      }
    }
    if (toolName === 'resolve_bh_facility' && data?.lat) {
      geo.origin = { lat: data.lat, lng: data.lng, label: data.name || 'BH Facility' };
    }
    if (toolName === 'baptist_health_location_lookup') {
      console.log(`[GeoAccum] BH lookup: data type=${typeof data}, isArray=${Array.isArray(data)}, length=${Array.isArray(data) ? data.length : 'N/A'}, sample keys=${data ? Object.keys(Array.isArray(data) ? (data[0] || {}) : data).join(',') : 'null'}`);
    }
    if (toolName === 'baptist_health_location_lookup' && Array.isArray(data)) {
      for (const e of data) {
        if (e.geocodedCoordinate?.latitude) {
          const entry = {
            name: e.name, lat: e.geocodedCoordinate.latitude, lng: e.geocodedCoordinate.longitude,
            address: e.address ? `${e.address.line1}, ${e.address.city}` : '',
            type: e.name?.match(/Urgent|Same-Day/i) ? 'urgent' : e.name?.match(/Hospital/i) ? 'hospital' : 'specialty'
          };
          geo.bhLocations.push(entry);
          // Persist to session memory (deduplicated)
          if (session?.knownEntities && !session.knownEntities.bhLocations.some(b => b.name === e.name && Math.abs(b.lat - entry.lat) < 0.001)) {
            session.knownEntities.bhLocations.push(entry);
          }
        }
      }
    }
    if (toolName === 'competitor_ratings_reviews' && Array.isArray(data)) {
      for (const p of data) {
        if (p.geometry?.location) {
          geo.competitors.push({
            name: p.name, lat: p.geometry.location.lat, lng: p.geometry.location.lng,
            address: p.formatted_address || '', rating: p.rating, reviews: p.user_ratings_total
          });
        }
      }
    }
    if (toolName === 'drive_time_isochrone' && data?.features) {
      geo.isochrone = data;
      // Identify ZIPs within isochrone
      if (zctaGeoJSON) {
        const catchmentZips = [];
        for (const f of zctaGeoJSON.features) {
          const zip = f.properties.ZCTA5CE20;
          const coords = f.geometry.coordinates[0];
          const cLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
          const cLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
          if (pointInIsochrone(cLat, cLng, data)) {
            catchmentZips.push(zip);
          }
        }
        geo.catchmentZips = catchmentZips;
      }
    }
  } catch (e) { console.error(`[GeoAccum] ERROR in ${toolName}:`, e.message); }
}

async function runAgentLoop(sessionId, userMessage, res) {
  const session = getSession(sessionId);
  session.messages.push({ role: 'user', content: userMessage });

  // Build dynamic system prompt based on intent
  const systemPrompt = buildSystemPrompt(userMessage);

  // Detect mode, plan type, intents, service lines
  const mode = detectMode(userMessage);
  const planType = mode === 'marketing_plan' ? detectPlanType(userMessage) : null;
  const intents = classifyIntent(userMessage);
  const serviceLines = extractServiceLines(userMessage);

  // Initialize evidence coverage tracker
  const evidence = createEvidenceCoverage(mode, planType, intents, serviceLines);

  // Reset origin coords for this run
  executeTool._originCoords = null;

  // SQLite: log run start
  const run = insertRun.run(sessionId, userMessage, JSON.stringify({ mode, planType, intents, serviceLines }), 'claude-sonnet-4-6');
  const runId = run.lastInsertRowid;

  let fullText = '';
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSteps = 0;

  // Geo data accumulator for map rendering
  const runGeo = { origin: null, bhLocations: [], competitors: [], isochrone: null, choropleth: null };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: session.messages,
      tools
    });

    const response = await stream.finalMessage();

    // Accumulate token counts
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;
    console.log(`[Agent] Iteration ${iterations}: stop_reason=${response.stop_reason}, input=${response.usage?.input_tokens}, output=${response.usage?.output_tokens}`);

    const assistantContent = response.content;
    let textParts = [];
    let toolCalls = [];

    for (const block of assistantContent) {
      if (block.type === 'text') {
        textParts.push(block.text);
        sendSSE(res, 'delta', { text: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push(block);
      }
    }

    session.messages.push({ role: 'assistant', content: assistantContent });

    // Handle max_tokens truncation — the model ran out of output space.
    // Ask it to continue instead of silently dropping the analysis.
    if (response.stop_reason === 'max_tokens' && toolCalls.length === 0) {
      console.warn(`[Agent] Hit max_tokens (8192) on iteration ${iterations}. Requesting continuation...`);
      session.messages.push({ role: 'user', content: 'Your response was cut off. Please continue where you left off — deliver the analysis with tables and data.' });
      continue;
    }

    if (response.stop_reason === 'end_of_turn' || toolCalls.length === 0) {
      fullText = textParts.join('');
      break;
    }

    // Execute tool calls with progress tracking
    const toolResults = [];
    const toolSummaries = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      const label = humanizeToolCall(toolCall.name, toolCall.input);

      // Send structured progress: start
      sendSSE(res, 'status', {
        message: `Calling ${toolCall.name.replace(/_/g, ' ')}...`,
        tool: toolCall.name, step: totalSteps + i + 1, total: totalSteps + toolCalls.length,
        phase: 'start', label
      });
      console.log(`[Agent] Tool call: ${toolCall.name}`, JSON.stringify(toolCall.input).substring(0, 200));

      const t0 = Date.now();
      const result = await executeTool(toolCall.name, toolCall.input);
      const duration = Date.now() - t0;
      // Strip _rawData before sending to model (it's only for geo accumulation)
      const { _rawData, ...resultForModel } = result;
      const fullContent = JSON.stringify(resultForModel);

      // Send structured progress: done
      sendSSE(res, 'status', {
        message: `${label} — done`,
        tool: toolCall.name, step: totalSteps + i + 1, total: totalSteps + toolCalls.length,
        phase: 'done', label, duration_ms: duration, result_count: result.result_count || 0
      });

      // Track evidence coverage
      updateEvidenceCoverage(evidence, toolCall.name, toolCall.input);

      // Accumulate geo data for potential map rendering
      accumulateGeoData(runGeo, toolCall.name, result, session);

      // Send map commands directly to client
      if (result._mapCommand || toolCall.name === 'map_control') {
        sendSSE(res, 'map_command', result.data || result);
      }

      // Accumulate choropleth data if this was a heat map tool call
      if (toolCall.name === 'generate_choropleth_map' && result._choropleth) {
        runGeo.choropleth = result._choropleth;
        delete result._choropleth; // don't send the full payload to the model
      }

      // SQLite: log tool call
      insertToolCall.run(
        runId, toolCall.name, JSON.stringify(toolCall.input),
        result.status || 'unknown', result.result_count || 0,
        JSON.stringify(result.warnings || []), duration, fullContent.length
      );

      toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: fullContent });
      toolSummaries.push({ type: 'tool_result', tool_use_id: toolCall.id, content: compressToolResult(toolCall.name, fullContent) });
    }
    totalSteps += toolCalls.length;

    session.messages.push({ role: 'user', content: toolResults });
  }

  if (iterations >= MAX_ITERATIONS) {
    sendSSE(res, 'delta', { text: '\n\n*[Max iterations reached. Some data may be incomplete.]*' });
    fullText += '\n\n*[Max iterations reached. Some data may be incomplete.]*';
  }

  // Check evidence coverage and log
  const evidenceResult = checkEvidenceCoverage(evidence);
  if (evidenceResult.missing.length > 0) {
    console.log(`[Evidence] GAPS DETECTED: ${evidenceResult.missing.join(' | ')}`);
    // Inject evidence gap warning into the response if agent didn't catch it
    const gapWarning = `\n\n*[Evidence coverage note: ${evidenceResult.missing.join('; ')}]*`;
    sendSSE(res, 'delta', { text: gapWarning });
    fullText += gapWarning;
  }
  console.log(`[Evidence] BH searched: [${evidence.bhServiceLinesSearched.join(', ')}] | Competitors: ${evidence.competitorSearches.length} searches | Geocode: ${evidence.geocodeDone} | Census: ${evidence.censusDone} | CDC: ${evidence.cdcDone}`);

  // Send map data if geo data was collected AND user asked for a map or isochrone was called
  const wantsMap = /map\s*(this|these|it|them|all|bh)|show.*map|plot.*map|map.*location|visuali|^map\b|a\s+map|the\s+map|provide.*map|complete.*map|include.*map/i.test(userMessage);
  // Fallback: if accumulateGeoData missed the origin, use executeTool._originCoords
  if (!runGeo.origin && executeTool._originCoords) {
    runGeo.origin = { lat: executeTool._originCoords.lat, lng: executeTool._originCoords.lng, label: 'Origin' };
  }
  // Merge session entities if current round has none (fixes BH pin loss after compression)
  if (session.knownEntities && runGeo.bhLocations.length === 0 && session.knownEntities.bhLocations.length > 0) {
    runGeo.bhLocations = [...session.knownEntities.bhLocations];
  }
  // AUTO-INJECT BH locations from cache if none were accumulated but query mentions BH or a service line
  // This ensures BH always maps when discussed, even if the agent only called competitor tools
  if (runGeo.bhLocations.length === 0 && bhFacilityCache.length > 0 && runGeo.origin) {
    const mentionsBH = /\b(bh|baptist\s*health|our\s+(location|facilit|urgent|hospital|imaging|primary|emergency|express))/i.test(userMessage);
    const mentionsServiceLine = /\b(urgent\s*care|hospital|imaging|primary\s*care|emergency|express|same.?day|radiol|mri|ct\b|cardio|ortho|neuro|spine|cancer|oncol|surg|endoscop|infusion|pharmac|sleep|urol|gastro|women|rehab|physical\s*therap)/i.test(userMessage);
    const isMarketBrief = /\b(market\s*brief|market\s*profile|competitive\s*landscape|trade\s*area)/i.test(userMessage);
    if (mentionsBH || mentionsServiceLine || isMarketBrief) {
      // Pull matching BH facilities from cache — filter by service type if specific, otherwise pull all nearby
      const serviceMatch = userMessage.match(/\b(urgent\s*care|hospital|imaging|primary\s*care|emergency|express|same.?day|radiol|cardio|ortho|neuro|spine|cancer|surg|endoscop|infusion|pharmac|sleep|urol|gastro|women|rehab|physical\s*therap)\b/i);
      const keyword = serviceMatch ? serviceMatch[1].toLowerCase() : null;

      let injected = bhFacilityCache.filter(e => {
        if (!e.geocodedCoordinate?.latitude) return false;
        // If a specific service line was mentioned, filter by name match
        if (keyword) {
          const eName = (e.name || '').toLowerCase();
          if (keyword.includes('urgent') || keyword.includes('same')) return /urgent|same.?day/i.test(eName);
          if (keyword.includes('hospital')) return /hospital/i.test(eName);
          if (keyword.includes('imaging') || keyword.includes('radiol') || keyword.includes('mri')) return /imaging|radiol|diagnostic/i.test(eName);
          if (keyword.includes('primary')) return /primary|family|internal/i.test(eName);
          if (keyword.includes('emergency')) return /emergency/i.test(eName);
          if (keyword.includes('express')) return /express/i.test(eName);
          if (keyword.includes('cardio')) return /cardio|heart|vascular/i.test(eName);
          if (keyword.includes('ortho')) return /orthop/i.test(eName);
          if (keyword.includes('neuro')) return /neuro|brain/i.test(eName);
          if (keyword.includes('spine')) return /spine/i.test(eName);
          if (keyword.includes('cancer') || keyword.includes('oncol')) return /cancer|oncol/i.test(eName);
          if (keyword.includes('surg')) return /surg/i.test(eName);
          // Fall through to all facilities
        }
        return true;
      }).map(e => ({
        name: e.name,
        lat: e.geocodedCoordinate.latitude,
        lng: e.geocodedCoordinate.longitude,
        address: e.address ? `${e.address.line1}, ${e.address.city}` : '',
        type: e.name?.match(/Urgent|Same-Day/i) ? 'urgent' : e.name?.match(/Hospital/i) ? 'hospital' : 'specialty'
      }));

      if (injected.length > 0) {
        runGeo.bhLocations = injected;
        console.log(`[Map] Auto-injected ${injected.length} BH locations from cache (keyword: ${keyword || 'all'})`);
      }
    }
  }

  const hasGeoData = runGeo.origin || runGeo.bhLocations.length > 0 || runGeo.competitors.length > 0;
  console.log(`[Map] Pre-filter: ${runGeo.bhLocations.length} BH, ${runGeo.competitors.length} comp, isochrone=${!!runGeo.isochrone} (${runGeo.isochrone?.features?.length || 0} features), wantsMap=${wantsMap}`);
  if (hasGeoData && (wantsMap || runGeo.isochrone)) {
    // Filter map pins: use isochrone polygon if available, otherwise use distance radius
    // Match miles but NOT minutes — "within 15 minute" should NOT match as 15 miles
    const radiusMatch = userMessage.match(/(?:within|around|inside)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:-?\s*)?mile/i)
      || userMessage.match(/(\d+(?:\.\d+)?)\s*(?:-?\s*)?mile\s*(?:radius|area|range|of)/i);
    // "near" = 5mi default; "within/inside" with no distance = use isochrone or 10mi
    const isNearQuery = /\bnear\b/i.test(userMessage) && !radiusMatch;
    let bhFiltered = runGeo.bhLocations;
    let compFiltered = runGeo.competitors;

    let bhOutsideRadius = []; // BH locations that were filtered out — agent should mention these

    if (runGeo.isochrone && runGeo.isochrone.features?.length > 0) {
      // ISOCHRONE EXISTS: filter pins to only those INSIDE the polygon
      bhFiltered = runGeo.bhLocations.filter(l => pointInIsochrone(l.lat, l.lng, runGeo.isochrone));
      bhOutsideRadius = runGeo.bhLocations.filter(l => !pointInIsochrone(l.lat, l.lng, runGeo.isochrone));
      compFiltered = runGeo.competitors.filter(c => pointInIsochrone(c.lat, c.lng, runGeo.isochrone));
      console.log(`[Map] Isochrone filter: ${runGeo.bhLocations.length} BH → ${bhFiltered.length} inside, ${bhOutsideRadius.length} outside | ${runGeo.competitors.length} comp → ${compFiltered.length} inside`);
    } else if (runGeo.origin) {
      // NO ISOCHRONE: use distance radius
      // "near" = 5mi, explicit miles = user value, default = 10mi
      const mapRadius = radiusMatch ? parseFloat(radiusMatch[1]) : (isNearQuery ? 5 : 10);
      bhFiltered = runGeo.bhLocations.filter(l =>
        haversineDistance(runGeo.origin.lat, runGeo.origin.lng, l.lat, l.lng) <= mapRadius
      );
      compFiltered = runGeo.competitors.filter(c =>
        haversineDistance(runGeo.origin.lat, runGeo.origin.lng, c.lat, c.lng) <= mapRadius
      );
      console.log(`[Map] Distance filter: ${runGeo.bhLocations.length} BH → ${bhFiltered.length} nearby | ${runGeo.competitors.length} comp → ${compFiltered.length} nearby (${mapRadius}mi${radiusMatch ? ' — user-specified' : isNearQuery ? ' — near default' : ' — default'})`);
    }
    // De-duplicate: remove competitors that are actually BH locations
    // Also: steal Google ratings from competitor pins and apply to matching BH pins
    const preDedupCount = compFiltered.length;
    compFiltered = compFiltered.filter(c => {
      const isBaptist = /baptist|baptist health/i.test(c.name);
      const matchingBH = bhFiltered.find(b => haversineDistance(b.lat, b.lng, c.lat, c.lng) < 0.1);
      if (isBaptist || matchingBH) {
        // Transfer Google rating to BH pin before removing
        if (matchingBH && c.rating) {
          matchingBH.rating = c.rating;
          matchingBH.reviews = c.reviews;
        }
        return false;
      }
      return true;
    });
    if (preDedupCount > compFiltered.length) {
      console.log(`[Map] De-dup: removed ${preDedupCount - compFiltered.length} competitors that are BH locations (transferred ratings)`);
    }

    // Jitter co-located pins so they don't stack on top of each other
    const allPins = [...bhFiltered, ...compFiltered];
    for (let i = 0; i < allPins.length; i++) {
      for (let j = i + 1; j < allPins.length; j++) {
        const dist = haversineDistance(allPins[i].lat, allPins[i].lng, allPins[j].lat, allPins[j].lng);
        if (dist < 0.02) { // Within ~100 feet — visually overlapping
          // Offset the second pin ~50m in a unique direction based on index
          const angle = ((j - i) * 137.5) * Math.PI / 180; // Golden angle for even spread
          const offsetDeg = 0.0004; // ~40m
          allPins[j].lat += Math.cos(angle) * offsetDeg;
          allPins[j].lng += Math.sin(angle) * offsetDeg;
        }
      }
    }

    // Text-match filter: only map competitors the agent actually mentioned in its response
    // This ensures the map matches exactly what the text discusses
    if (fullText && compFiltered.length > 0) {
      const responseText = fullText.toLowerCase();
      const preTextMatch = compFiltered.length;
      compFiltered = compFiltered.filter(c => {
        const name = c.name.toLowerCase();
        // Check if the competitor name (or a significant portion) appears in the response
        // Try full name first, then first two words (handles "Sanitas Medical Center" → "Sanitas")
        if (responseText.includes(name)) return true;
        const words = name.split(/\s+/);
        if (words.length >= 2 && responseText.includes(words[0] + ' ' + words[1])) return true;
        // Single distinctive word (skip generic: "urgent", "care", "medical", "center", "clinic")
        const generic = new Set(['urgent', 'care', 'medical', 'center', 'clinic', 'health', 'hospital', 'emergency', 'florida', 'south']);
        const distinctive = words.filter(w => w.length > 3 && !generic.has(w));
        return distinctive.some(w => responseText.includes(w));
      });
      if (preTextMatch > compFiltered.length) {
        console.log(`[Map] Text-match: kept ${compFiltered.length}/${preTextMatch} competitors mentioned in response`);
      }
    }

    const mapData = {
      center: runGeo.origin || (bhFiltered[0] ? { lat: bhFiltered[0].lat, lng: bhFiltered[0].lng } : null),
      origin: runGeo.origin,
      bhLocations: bhFiltered,
      competitors: compFiltered,
      isochrone: runGeo.isochrone,
      catchmentZips: runGeo.catchmentZips || null,
      bhOutsideRadius: bhOutsideRadius.length > 0 ? bhOutsideRadius : null
    };
    sendSSE(res, 'map_data', mapData);
    console.log(`[Map] Sent: ${bhFiltered.length} BH + ${compFiltered.length} competitors${runGeo.isochrone ? ' + isochrone' : ''}${bhOutsideRadius.length > 0 ? ` (${bhOutsideRadius.length} BH outside radius)` : ''}`);

    // If BH locations were filtered out, mention only the closest 3 (not a wall of 30 names)
    if (bhOutsideRadius.length > 0 && runGeo.origin) {
      const withDist = bhOutsideRadius.map(l => ({
        name: l.name.replace(/^Baptist Health\s*/i, 'BH '),
        dist: haversineDistance(runGeo.origin.lat, runGeo.origin.lng, l.lat, l.lng)
      })).sort((a, b) => a.dist - b.dist);
      const closest = withDist.slice(0, 3);
      const closestNames = closest.map(l => `${l.name} (${l.dist.toFixed(1)} mi)`).join(', ');
      const note = `\n\n> **Note:** ${bhOutsideRadius.length} additional BH locations are outside the radius. Closest: ${closestNames}.`;
      fullText += note;
      sendSSE(res, 'delta', { text: note });
    }
  }

  // Send choropleth data if heat map was generated
  if (runGeo.choropleth) {
    runGeo.choropleth.bhLocations = runGeo.bhLocations;
    runGeo.choropleth.competitors = runGeo.competitors;
    sendSSE(res, 'choropleth_data', runGeo.choropleth);
    console.log(`[Choropleth] Sent: ${Object.keys(runGeo.choropleth.zipData).length} ZIPs, metric=${runGeo.choropleth.metric}`);
  }

  // Compress ALL tool results in session history for future queries.
  // Full data was used during this query — only summaries needed for follow-ups.
  let compCount = 0;
  for (let mi = 0; mi < session.messages.length; mi++) {
    const msg = session.messages[mi];
    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
      const before = JSON.stringify(msg.content).length;
      msg.content = msg.content.map(tr => ({
        ...tr,
        content: typeof tr.content === 'string' && tr.content.length > 2000
          ? compressToolResult('session', tr.content)
          : tr.content
      }));
      compCount++;
    }
  }
  if (compCount > 0) console.log(`[Session] Compressed ${compCount} tool result set(s) for future queries`);

  trimSession(session);

  // SQLite: update run with final data
  const costCents = ((totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000) * 100;
  updateRun.run(iterations, totalInputTokens, totalOutputTokens, costCents, fullText.substring(0, 10000), runId);

  return fullText;
}

// ── Yext Preload Proxy (removes API key from client) ──────────────────────
app.get('/api/yext-preload', async (req, res) => {
  try {
    const url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareFacility&limit=50&fields=name,address,geocodedCoordinate,closed`;
    const yextRes = await fetchWithTimeout(url);
    const data = await yextRes.json();
    res.json(data.response?.entities || []);
  } catch (err) {
    res.status(500).json({ error: 'Yext preload failed' });
  }
});

// ── ZCTA GeoJSON Endpoint (ZIP boundaries for choropleth) ─────────────────
app.get('/api/zcta-geojson', (req, res) => {
  if (!zctaGeoJSON) return res.status(404).json({ error: 'ZCTA GeoJSON not available. Run: node scripts/build-zcta-geojson.js' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(zctaGeoJSON);
});

// ── County Boundaries GeoJSON Endpoint ────────────────────────────────────
let countyGeoJSON = null;
try {
  countyGeoJSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'counties-south-florida.geojson'), 'utf8'));
  console.log(`  County boundaries: ${countyGeoJSON.features.length} counties loaded`);
} catch (e) { console.warn('  County boundaries: not available'); }

app.get('/api/county-geojson', (req, res) => {
  if (!countyGeoJSON) return res.status(404).json({ error: 'County GeoJSON not available' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(countyGeoJSON);
});

// ── Mapbox Token Endpoint ──────────────────────────────────────────────────
app.get('/api/mapbox-token', (req, res) => {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'MAPBOX_ACCESS_TOKEN not configured' });
  res.json({ token });
});

// ── Permit Refresh Endpoint ─────────────────────────────────────────────────

app.post('/api/refresh-permits', async (req, res) => {
  console.log('[Permits] Refresh triggered');
  try {
    const { refreshPermits } = require('./scripts/refresh-permits');
    const result = await refreshPermits();
    res.json(result);
  } catch (err) {
    console.error('[Permits] Refresh error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Newsletter Generation (Async) ───────────────────────────────────────────
// POST returns job ID immediately. Generation runs in background.
// GET /api/newsletter-status/:jobId to poll for result.

let latestNewsletterResult = { status: 'idle' };

app.post('/api/generate-newsletter', (req, res) => {
  const forceRefresh = req.body?.force_permits === true;

  latestNewsletterResult = { status: 'running', started: new Date().toISOString() };
  console.log('\n═══ Newsletter Generation Started ═══');

  // Return immediately
  res.json({ status: 'accepted' });

  // Run generation in background
  (async () => {
    const startTime = Date.now();
    try {
      // Step 1: Refresh permits (monthly)
      const { db: permitDb } = require('./db');
      const lastRun = permitDb.prepare("SELECT run_date FROM scraper_runs WHERE status IN ('success','partial') ORDER BY run_date DESC LIMIT 1").get();
      const daysSinceRefresh = lastRun ? (Date.now() - new Date(lastRun.run_date).getTime()) / 86400000 : 999;

      let permitResult = { status: 'skipped', total_active: permitDb.prepare('SELECT COUNT(*) as n FROM permits WHERE is_active=1').get().n };

      if (forceRefresh || daysSinceRefresh >= 25) {
        console.log(`[Newsletter] Refreshing permits (${Math.round(daysSinceRefresh)} days since last)...`);
        const { refreshPermits } = require('./scripts/refresh-permits');
        permitResult = await refreshPermits();
      } else {
        console.log(`[Newsletter] Skipping permit refresh (${Math.round(daysSinceRefresh)} days ago, ${permitResult.total_active} active)`);
      }

      // Step 2: Build prompt
      const today = new Date();
      const cycleEnd = new Date(today);
      cycleEnd.setDate(cycleEnd.getDate() - cycleEnd.getDay());
      const cycleStart = new Date(cycleEnd);
      cycleStart.setDate(cycleStart.getDate() - 13);

      const formatDate = (d) => d.toISOString().split('T')[0];
      const formatDisplay = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      const generationPrompt = `You are generating the Insight Miner bi-weekly newsletter for: ${formatDisplay(cycleStart)} – ${formatDisplay(cycleEnd)}.

TASK: Research all 7 sections, then output a COMPLETE JSON object with the content for each section. Do NOT output HTML — output structured JSON that I will merge into the HTML template.

Research window: ${formatDisplay(cycleStart)} through ${formatDisplay(cycleEnd)}.
Since date for permit deltas: ${formatDate(cycleStart)}
Today's date: ${formatDisplay(today)}

STEP 1: Research. Use web_research and read_page to gather fresh stories for ALL 7 sections:
  1. PRIMARY SERVICE AREA NEWS — EXTERNAL market stories only. Competitor moves, payer disputes, healthcare real estate, regulatory actions. NEVER include Baptist Health's own projects here — those go in Section 4 (Permits).
  2. COMPETITIVE INTELLIGENCE — Who's building, buying, positioning. CapEx data. Threat assessments. Steward watch.
  3. AI & MARKETING TECHNOLOGY — Healthcare AI, marketing AI, tools competitors are deploying.
  4. PERMIT & CONSTRUCTION TRACKER — Call lookup_permits with since_date="${formatDate(cycleStart)}" and include_history=true.
  5. MERGERS & ACQUISITIONS — Hospital + physician practice deals. Private equity activity. Florida focus.
  6. POLICY & MACRO — Coverage changes, reimbursement, Medicaid/Medicare policy shifts.
  7. INSIGHTS TO THINK ABOUT — 5-7 strategic provocations for marketing leadership.

STEP 2: After ALL research is complete, output a single JSON object with this exact structure:
{
  "issue_date_range": "April 21 – May 4, 2026",
  "vol_issue": "Vol. 1 — Issue 02",
  "hero_headline": "Main attention-grabbing headline with <em>emphasis part</em>",
  "exec_summary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "stats": [
    {"num": "7", "label": "description"},
    {"num": "$2.1B", "label": "description"},
    {"num": "22", "label": "description"},
    {"num": "1.5M", "label": "description"}
  ],
  "sections": {
    "s1_psa_news": {
      "subtitle": "section subtitle",
      "stories": [
        {
          "type": "threat|watch|opp|neutral",
          "tag_text": "Tag Label",
          "tag_color": "red|yellow|blue|gray",
          "headline": "Story headline",
          "body_html": "<p>Story body with <strong>bold</strong> as needed.</p>",
          "marketing_impact_html": "<p>Impact analysis.</p>",
          "impact_dots": 4,
          "sources_html": "<a href='url'>Source Name</a>, <a href='url'>Source 2</a>"
        }
      ]
    },
    "s2_competitive": {
      "subtitle": "section subtitle",
      "capex_chart": [{"label": "HCA Florida", "value": "$1.8B", "width_pct": 90, "color": "var(--coral)"}],
      "stories": [same format as s1],
      "fsed_cards": [{"system": "Name", "description": "details"}],
      "steward_hospitals": [{"name": "...", "location": "...", "county": "..."}]
    },
    "s3_ai_tech": {
      "subtitle": "...",
      "stories": [same format],
      "bottom_line_html": "<p>Summary callout text.</p>"
    },
    "s4_permits": {
      "subtitle": "...",
      "permits_table": [{"project": "...", "system": "...", "county": "...", "value": "...", "status": "...", "delta": "NEW|UPDATED|", "source_url": "..."}]
    },
    "s5_ma": {
      "subtitle": "...",
      "deal_count_headline": "...",
      "stories": [same format],
      "callout_html": "<p>...</p>"
    },
    "s6_policy": {
      "subtitle": "...",
      "metric_cards": [{"num": "1.5M", "description": "...", "color": "red|yellow|green"}],
      "stories": [same format]
    },
    "s7_insights": {
      "insights": [{"headline": "...", "body": "..."}]
    }
  }
}

RULES:
- Section 1 is EXTERNAL news ONLY. Baptist Health projects, expansions, and groundbreakings belong in Section 4 (Permits), NOT Section 1.
- Every story MUST have a marketing_impact_html field.
- Every source MUST be a clickable <a href> link with the real URL.
- Spell out all terms — no acronyms (only exception: BH).
- Territory is "Primary Service Area" — never "POA".

EFFICIENCY — YOU HAVE LIMITED ITERATIONS:
- Batch multiple web_research calls in a SINGLE turn (call 3-4 at once, not one at a time).
- Batch multiple read_page calls in a single turn too.
- Complete ALL research within 5-6 turns. Then output the JSON in your final turn.
- Do NOT do one tool call per turn — that wastes iterations and you will run out before producing output.
- You MUST output the JSON object before your iterations run out. Research is useless without output.

Output ONLY the JSON object. No markdown, no commentary, no code fences.`;

      // Step 3: Agentic loop
      let pulsePrompt = '';
      try { pulsePrompt = fs.readFileSync(path.join(PROMPT_DIR, 'workflow-pulse.txt'), 'utf8'); } catch (e) {}
      const insightMinerPrompt = pulsePrompt
        ? `${CORE_PROMPT}\n\n${REF_PROMPT}\n\n${pulsePrompt}`
        : buildSystemPrompt('insight miner newsletter permit construction competitive ai policy');

      const sessionId = `newsletter-${Date.now()}`;
      const session = getSession(sessionId);
      session.messages.push({ role: 'user', content: generationPrompt });

      const newsletterTools = tools.filter(t =>
        ['web_research', 'read_page', 'lookup_permits'].includes(t.name)
      );

      let fullText = '';
      let iterations = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (iterations < 12) {
        iterations++;
        console.log(`[Newsletter] Iteration ${iterations}...`);

        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 16384,
          system: insightMinerPrompt,
          messages: session.messages,
          tools: newsletterTools
        });

        totalInputTokens += response.usage?.input_tokens || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        const assistantContent = response.content;
        let textParts = [];
        let toolCalls = [];

        for (const block of assistantContent) {
          if (block.type === 'text') textParts.push(block.text);
          else if (block.type === 'tool_use') toolCalls.push(block);
        }

        session.messages.push({ role: 'assistant', content: assistantContent });

        if (response.stop_reason === 'end_of_turn' || toolCalls.length === 0) {
          fullText = textParts.join('');
          break;
        }

        const toolResults = [];
        for (const toolCall of toolCalls) {
          console.log(`  [Tool] ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`);
          const result = await executeTool(toolCall.name, toolCall.input);
          toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) });
        }
        session.messages.push({ role: 'user', content: toolResults });
      }

      // Step 4: Parse JSON
      let jsonStr = fullText.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\n?([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      const jsonStart = jsonStr.indexOf('{');
      const jsonEnd = jsonStr.lastIndexOf('}');
      if (jsonStart > -1 && jsonEnd > jsonStart) jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);

      const data = JSON.parse(jsonStr);

      // Step 5: Build HTML
      const { buildNewsletterHtml } = require('./scripts/build-newsletter-html');
      const html = buildNewsletterHtml(data, formatDisplay(cycleStart), formatDisplay(cycleEnd));

      const filename = `insight-miner-${formatDate(today)}.html`;
      const outputDir = path.join(__dirname, 'data');
      const outputPath = path.join(outputDir, filename);
      fs.writeFileSync(outputPath, html, 'utf-8');
      console.log(`[Newsletter] Saved: ${outputPath}`);

      const duration = Date.now() - startTime;
      const costCents = ((totalInputTokens * 3 / 1000000) + (totalOutputTokens * 15 / 1000000)) * 100;

      const { insertRun, updateRun } = require('./db');
      const runId = insertRun.run(sessionId, 'generate-newsletter', 'pulse', 'claude-sonnet-4-6').lastInsertRowid;
      updateRun.run(iterations, totalInputTokens, totalOutputTokens, costCents, `Generated ${filename}`, runId);

      sessions.delete(sessionId);

      console.log(`\n═══ Newsletter Complete ═══`);
      console.log(`Iterations: ${iterations} | Cost: ~$${(costCents/100).toFixed(2)} | Time: ${(duration/1000).toFixed(0)}s\n`);

      latestNewsletterResult = {
        status: 'success',
        filename,
        iterations,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        estimated_cost_cents: Math.round(costCents),
        duration_ms: duration,
        permits: permitResult
      };

    } catch (err) {
      console.error('[Newsletter] Error:', err.message);
      latestNewsletterResult = { status: 'error', message: err.message };
    }
  })();
});

// Poll for latest newsletter generation status
app.get('/api/newsletter-status', (req, res) => {
  res.json(latestNewsletterResult);
});

// Get the latest newsletter — returns { status, filename, html, generated_at }
// This is what n8n calls to get the newsletter content for emailing.
app.get('/api/latest-newsletter', (req, res) => {
  try {
    const dataDir = path.join(__dirname, 'data');
    const files = fs.readdirSync(dataDir)
      .filter(f => f.startsWith('insight-miner-') && f.endsWith('.html'))
      .sort()
      .reverse();
    if (files.length === 0) {
      return res.json({ status: 'none', message: 'No newsletter has been generated yet.' });
    }
    const filename = files[0];
    const html = fs.readFileSync(path.join(dataDir, filename), 'utf-8');
    const stat = fs.statSync(path.join(dataDir, filename));
    res.json({
      status: 'ready',
      filename,
      html,
      generated_at: stat.mtime.toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Serve generated newsletter HTML files in browser
app.get('/api/newsletter-file/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'data', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(filePath);
});

// ── Built-in Newsletter Cron ────────────────────────────────────────────────
// Generates newsletter every other Sunday at 10 PM ET.
// The HTML is ready by Monday 9 AM when n8n emails it.
(function startNewsletterCron() {
  const GENERATION_HOUR = 22; // 10 PM
  const GENERATION_DAY = 0;   // Sunday
  const INTERVAL_WEEKS = 2;

  let lastGenerationWeek = -1;

  setInterval(() => {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const weekNum = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
    const isBiWeek = weekNum % INTERVAL_WEEKS === 0;

    if (day === GENERATION_DAY && hour === GENERATION_HOUR && isBiWeek && lastGenerationWeek !== weekNum) {
      lastGenerationWeek = weekNum;
      console.log('\n[Cron] Triggering bi-weekly newsletter generation...');
      // Simulate a POST to generate-newsletter
      const http = require('http');
      const req = http.request({ hostname: 'localhost', port: process.env.PORT || 5000, path: '/api/generate-newsletter', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
      req.write('{}');
      req.end();
    }
  }, 60 * 60 * 1000); // Check every hour
})();

// ── API Endpoint ────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { query, session_id } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const sessionId = session_id || `anon-${Date.now()}`;

  // Rate limit check
  if (!checkRateLimit(sessionId)) {
    return res.status(429).json({ error: 'Rate limit exceeded (30 queries/hour). Please wait.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  req.setTimeout(0);
  res.setTimeout(0);

  try {
    const fullText = await runAgentLoop(sessionId, query, res);
    sendSSE(res, 'done', { text: fullText });
  } catch (err) {
    console.error('[Chat] Error:', err);
    sendSSE(res, 'error', { message: err.message || 'Something went wrong' });
  } finally {
    res.end();
  }
});

// ── Legacy endpoint ─────────────────────────────────────────────────────────
app.post('/webhook/market-research', async (req, res) => {
  const { query, session_id } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const sessionId = session_id || `anon-${Date.now()}`;
  const systemPrompt = buildSystemPrompt(query);

  try {
    const session = getSession(sessionId);
    session.messages.push({ role: 'user', content: query });

    let fullText = '';
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        messages: session.messages,
        tools
      });

      const assistantContent = response.content;
      let textParts = [];
      let toolCalls = [];

      for (const block of assistantContent) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'tool_use') toolCalls.push(block);
      }

      session.messages.push({ role: 'assistant', content: assistantContent });

      if (response.stop_reason === 'end_of_turn' || toolCalls.length === 0) {
        fullText = textParts.join('');
        break;
      }

      const toolResults = [];
      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall.name, toolCall.input);
        toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) });
      }
      session.messages.push({ role: 'user', content: toolResults });
    }

    trimSession(session);
    res.json({ response: fullText });
  } catch (err) {
    console.error('[Legacy] Error:', err);
    res.status(500).json({ response: 'Error: ' + err.message });
  }
});

// ── Start (only when run directly, not when imported for tests) ─────────────
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  BH Market Research Agent v3 running at http://localhost:${PORT}\n`);
    console.log(`  Tools: ${tools.length} registered`);
    console.log(`  Prompts: modular (core + ${Object.keys(WORKFLOW_FILES).length} workflows + reference)`);
    console.log(`  Core prompt: ${CORE_PROMPT.length} chars`);
    console.log(`  Ledger: SQLite at data/mra-ledger.db`);
    console.log(`  Auth: ${process.env.MRA_USERNAME ? 'ENABLED' : 'disabled (set MRA_USERNAME/MRA_PASSWORD to enable)'}`);
    console.log(`  Streaming: /api/chat (SSE)`);
    console.log(`  Legacy: /webhook/market-research (JSON)\n`);
  });
}

// ── Exports for testing ─────────────────────────────────────────────────────
if (require.main !== module) {
  module.exports = { executeTool, envelope, normalizeCity, classifyIntent, detectMode, detectPlanType, extractServiceLines, createEvidenceCoverage, updateEvidenceCoverage, checkEvidenceCoverage, SPECIALTY_SYNONYMS, CITY_ALIASES, SERVICE_LINE_KEYWORDS, buildSystemPrompt, warn, haversineDistance };
}
