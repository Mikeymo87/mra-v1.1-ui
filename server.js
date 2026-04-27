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
const REF_PROMPT = fs.readFileSync(path.join(PROMPT_DIR, 'reference-data.txt'), 'utf8');

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
  if (/physician|doctor|specialist|referral.*physician|who.*(bh|baptist).*(doctor|physician)|find.*(cardio|ortho|neuro|family\s*medicine|internal\s*medicine)/i.test(q))
    intents.add('physicians');
  if (/competitor|competition|competitive|rival|hca|jackson|cleveland\s*clinic|memorial|mount\s*sinai|threat|who.*there|who.*nearby/i.test(q))
    intents.add('competitive');
  if (/psychograph|segment|tapestry|lifestyle|cohort|health\s*behavior|cdc|behavioral|preventive\s*care|chronic\s*disease/i.test(q))
    intents.add('psychographic');
  if (/new\s*facility|cannibali|feeder|referral\s*corridor|overlap.*feeder/i.test(q))
    intents.add('facility');
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
  if (toolName === 'cdc_health_behaviors') coverage.cdcDone = true;

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
          description: 'URL-encoded Yext filter JSON. Single keyword: %7B%22name%22%3A%7B%22%24contains%22%3A%22KEYWORD%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D — KEYWORD examples: Primary%2BCare, Imaging, Orthop, Cardio, Cancer, Neuro, Surgery. For urgent/same-day (one category): %7B%22%24or%22%3A%5B%7B%22name%22%3A%7B%22%24contains%22%3A%22Urgent%2BCare%22%7D%7D%2C%7B%22name%22%3A%7B%22%24contains%22%3A%22Same-Day%2BCare%22%7D%7D%5D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D'
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
    description: 'Live web search via OpenAI gpt-4o with web_search_preview. Use for market trends, Esri Tapestry segments, competitor news, all-provider searches. Translate non-English results to English.',
    input_schema: {
      type: 'object',
      properties: {
        research_query: { type: 'string', description: 'Research query. For all-provider searches search broadly including competitors.' }
      },
      required: ['research_query']
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
    description: 'OpenRouteService API. Generates drive-time polygons as GeoJSON. Coordinates are [longitude, latitude] (NOT lat,lon). Range in seconds: 300=5min, 600=10min, 900=15min, 1200=20min. Max 3 ranges per call.',
    input_schema: {
      type: 'object',
      properties: {
        locations: { type: 'array', description: 'Array of [longitude, latitude] coordinate pairs.', items: { type: 'array', items: { type: 'number' } } },
        range: { type: 'array', description: 'Array of range values in seconds.', items: { type: 'number' } }
      },
      required: ['locations', 'range']
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
    data: truncateResult(data)
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
        url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareFacility&limit=50&fields=name,address,geocodedCoordinate,closed&filter=${input.filter}`;
        source = url.replace(process.env.YEXT_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        let entities = data.response?.entities || [];
        let filterMeta = null;

        // Distance pre-filter: if we have origin coords, keep only nearby results
        if (executeTool._originCoords && entities.length > 5) {
          const maxMiles = (executeTool._filterRadius || 10) * 2;
          const before = entities.length;
          // Add distance to each entity for sorting
          entities = entities.map(e => {
            const lat = e.geocodedCoordinate?.latitude;
            const lon = e.geocodedCoordinate?.longitude;
            e._distMiles = (lat && lon) ? haversineDistance(executeTool._originCoords.lat, executeTool._originCoords.lng, lat, lon) : 999;
            return e;
          }).filter(e => e._distMiles <= maxMiles);
          // Sort by distance, keep nearest 20
          entities.sort((a, b) => a._distMiles - b._distMiles);
          if (entities.length > 20) entities = entities.slice(0, 20);
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
        url = 'https://api.openai.com/v1/responses';
        source = 'OpenAI gpt-4o web_search_preview';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }], input: input.research_query })
        }, 60000);
        data = await res.json();
        const output = data.output?.filter(o => o.type === 'message')
          .flatMap(o => o.content?.filter(c => c.type === 'output_text').map(c => c.text))
          .join('\n') || JSON.stringify(data.output);
        return envelope(source, 'openai.com/v1/responses', timestamp, output, {
          query: { research_query: input.research_query }
        });
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
        url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
        source = 'OpenRouteService Isochrone API';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': process.env.ORS_API_KEY },
          body: JSON.stringify({ locations: input.locations, range: input.range, range_type: 'time' })
        });
        data = await res.json();
        return envelope(source, url, timestamp, data, {
          query: { locations: input.locations, range: input.range }
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
    sessions.set(sessionId, { messages: [], lastAccess: Date.now() });
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

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: session.messages,
      tools
    });

    const response = await stream.finalMessage();

    // Accumulate token counts
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

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

    if (response.stop_reason === 'end_of_turn' || toolCalls.length === 0) {
      fullText = textParts.join('');
      break;
    }

    // Execute tool calls
    const toolResults = [];
    const toolSummaries = [];
    for (const toolCall of toolCalls) {
      sendSSE(res, 'status', { message: `Calling ${toolCall.name.replace(/_/g, ' ')}...` });
      console.log(`[Agent] Tool call: ${toolCall.name}`, JSON.stringify(toolCall.input).substring(0, 200));

      const t0 = Date.now();
      const result = await executeTool(toolCall.name, toolCall.input);
      const duration = Date.now() - t0;
      const fullContent = JSON.stringify(result);

      // Track evidence coverage
      updateEvidenceCoverage(evidence, toolCall.name, toolCall.input);

      // SQLite: log tool call
      insertToolCall.run(
        runId, toolCall.name, JSON.stringify(toolCall.input),
        result.status || 'unknown', result.result_count || 0,
        JSON.stringify(result.warnings || []), duration, fullContent.length
      );

      toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: fullContent });
      toolSummaries.push({ type: 'tool_result', tool_use_id: toolCall.id, content: compressToolResult(toolCall.name, fullContent) });
    }

    session.messages.push({ role: 'user', content: toolResults });

    if (iterations > 0) {
      session._pendingCompression = session._pendingCompression || [];
      session._pendingCompression.push({ index: session.messages.length - 1, compressed: toolSummaries });
    }
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

  // Compress tool results in session history
  if (session._pendingCompression) {
    const count = session._pendingCompression.length;
    for (const { index, compressed } of session._pendingCompression) {
      if (session.messages[index] && session.messages[index].role === 'user') {
        session.messages[index].content = compressed;
      }
    }
    delete session._pendingCompression;
    console.log(`[Session] Compressed ${count} tool result set(s) in session history`);
  }

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
        max_tokens: 4096,
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
