require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8');
const sessions = new Map(); // sessionId -> [{role, content}]
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_MESSAGES = 40; // 20 exchanges
const MAX_ITERATIONS = 25;

// Cleanup stale sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL) sessions.delete(id);
  }
}, 30 * 60 * 1000);

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
    description: 'Fetches US Census ACS 5-Year data for demographics, age/sex breakdown, income, payer mix, and psychographic proxy variables. Supports 3 endpoints: Detailed Tables (default path), Data Profiles (/profile), Subject Tables (/subject). Max 25 variables per call. Server automatically retries with 2023 data if 2024 fails.',
    input_schema: {
      type: 'object',
      properties: {
        year: {
          type: 'string',
          description: 'Dataset year. Use "2024" first. If it fails, server retries with "2023" automatically.',
          enum: ['2024', '2023']
        },
        endpoint: {
          type: 'string',
          description: 'Endpoint suffix and full query string. MAX 25 variables per call. Examples: /profile?get=NAME,DP03_0097E,DP03_0097PE&for=zip+code+tabulation+area:33131 or /subject?get=NAME,S2704_C02_002E&for=zip+code+tabulation+area:33131 or ?get=NAME,B01001_001E&for=county:086. Multiple ZIPs: comma-separated. State prefix &in=state:12 NOT supported for ZIPs.'
        }
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
        research_query: {
          type: 'string',
          description: 'Research query. For all-provider searches search broadly including competitors. For HCA also include MD Now. Examples: all primary care and specialty clinics Pembroke Pines Florida 2025, Cleveland Clinic Florida orthopedics expansion 2025'
        }
      },
      required: ['research_query']
    }
  },
  {
    name: 'geocode_address',
    description: 'Converts an address to lat/lng coordinates via Google Geocoding API.',
    input_schema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'URL-encoded address. Replace spaces with +. CRITICAL: Always include the EXACT city name from the user query plus FL and USA. Many South Florida addresses exist in multiple cities (e.g., 1400 SW 145th Ave exists in BOTH Miami and Pembroke Pines, 17 miles apart). Dropping the city name will geocode to the WRONG location. Example: 1400+SW+145th+Ave+Pembroke+Pines+FL+USA'
        }
      },
      required: ['address']
    }
  },
  {
    name: 'calculate_drive_times',
    description: 'Calculates drive time and distance between locations via Google Distance Matrix API.',
    input_schema: {
      type: 'object',
      properties: {
        origins: {
          type: 'string',
          description: 'Pipe-separated origin coordinates as lat,lng. Example: 25.7617,-80.1918|25.7750,-80.2100. Max 25.'
        },
        destinations: {
          type: 'string',
          description: 'Pipe-separated destination coordinates as lat,lng. Max 25.'
        }
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
        query: {
          type: 'string',
          description: 'URL-encoded Google Places search query. Include location. Examples: primary+care+Pembroke+Pines+Florida, orthopedic+clinic+Weston+Florida, urgent+care+Brickell+Miami+Florida'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'google_reviews_deep_pull',
    description: 'Outscraper API for full review data with dates, text, business responses. Supports batch (10 locations), date filtering, up to 100 reviews/location. Use for sentiment analysis, name extraction, theme analysis.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'URL-encoded location query. For batch use %0A between locations (max 10). Example: Baptist+Health+Primary+Care+Plantation+FL'
        },
        reviewsLimit: {
          type: 'number',
          description: 'Number of reviews per location. 20 for quick check, 50 for analysis, 100 for deep dive.'
        },
        cutoff: {
          type: 'string',
          description: 'Optional Unix timestamp to filter reviews newer than date. Omit for no cutoff.'
        }
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
        locations: {
          type: 'array',
          description: 'Array of [longitude, latitude] coordinate pairs.',
          items: { type: 'array', items: { type: 'number' } }
        },
        range: {
          type: 'array',
          description: 'Array of range values in seconds. Example: [600, 900, 1200]',
          items: { type: 'number' }
        }
      },
      required: ['locations', 'range']
    }
  },
  {
    name: 'baptist_health_physician_lookup',
    description: 'Looks up Baptist Health physicians/doctors from Yext. Returns name, specialty, degrees, address, coordinates, phone, languages, NPI, ratings, accepting status. Use c_listOfSpecialties for specialty filter (NOT c_specialty). Use address.city to narrow by city. Limit 50 per call — always filter by city or specialty to avoid truncation. IMPORTANT: For geographic physician searches, you MUST search ALL adjacent cities. Pembroke Pines requires 9 calls: Pembroke Pines, Miramar, Hollywood, Cooper City, Davie, Weston, Miami Gardens, Hialeah, Miami Lakes. Do NOT stop after 4 cities.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'URL-encoded Yext filter JSON. By specialty: %7B%22c_listOfSpecialties%22%3A%7B%22%24contains%22%3A%22SPECIALTY%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D — SPECIALTY examples: Cardio, Orthop, Neuro, Family+Medicine, Internal+Medicine, Surgery, Gastro, Urolog, OB, Pediatr, Emergency, Pulmon, Dermatol, Endocrin, Ophthalmol, Radiol, Rheumat, Psychiatr, Pain. By specialty+city: %7B%22c_listOfSpecialties%22%3A%7B%22%24contains%22%3A%22SPECIALTY%22%7D%2C%22address.city%22%3A%7B%22%24eq%22%3A%22CITY%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D. By name: %7B%22name%22%3A%7B%22%24contains%22%3A%22DOCTOR_NAME%22%7D%2C%22closed%22%3A%7B%22%24eq%22%3Afalse%7D%7D'
        }
      },
      required: ['filter']
    }
  },
  {
    name: 'cdc_health_behaviors',
    description: 'Looks up CDC PLACES health behavior and lifestyle data for South Florida ZIP codes. Returns 33 measures per ZIP including: obesity, smoking, physical inactivity, depression, preventive care visits, dental visits, binge drinking, chronic diseases (diabetes, heart disease, COPD, cancer), sleep, disabilities, and mental/physical health days. Data is from 2025 PLACES release (2023 BRFSS data). Coverage: 195 ZIPs across Miami-Dade, Broward, Palm Beach, and Monroe counties. Use this tool ALONGSIDE Census demographics to build richer psychographic profiles — it provides actual BEHAVIORAL data, not just demographic proxies.',
    input_schema: {
      type: 'object',
      properties: {
        zip_codes: {
          type: 'string',
          description: 'Comma-separated ZIP codes to look up. Example: "33027,33028,33025". Returns health behavior data for each ZIP found in the database.'
        }
      },
      required: ['zip_codes']
    }
  }
];

// ── Load CDC PLACES data ────────────────────────────────────────────────────
const CDC_PLACES_PATH = path.join(__dirname, 'data', 'cdc-places-south-florida.json');
let cdcPlacesData = {};
try {
  cdcPlacesData = JSON.parse(fs.readFileSync(CDC_PLACES_PATH, 'utf8'));
  console.log(`  CDC PLACES: ${Object.keys(cdcPlacesData).length} ZIPs loaded`);
} catch (err) {
  console.warn('  CDC PLACES: data file not found — cdc_health_behaviors tool will return empty results');
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

// Compress tool results for session history to prevent token bloat.
// The agent gets full data during the current iteration but subsequent queries
// only see a compact summary (tool name, record count, key fields).
function compressToolResult(toolName, fullContent) {
  const MAX_SUMMARY = 2000; // chars — enough context for follow-ups without full JSON
  try {
    const parsed = JSON.parse(fullContent);
    const data = parsed.data || parsed;

    // For arrays (Yext results, Distance Matrix, Census), summarize count + first few items
    if (Array.isArray(data)) {
      const summary = {
        _compressed: true,
        tool: toolName,
        total_records: data.length,
        sample: data.slice(0, 3),
        note: `Full data had ${data.length} records. This is a compressed summary for session context.`
      };
      return JSON.stringify(summary).substring(0, MAX_SUMMARY);
    }

    // For objects with nested data arrays
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      // If it has an error, keep it small
      if (data.error) return JSON.stringify({ _compressed: true, tool: toolName, error: data.error });
      // Census returns arrays of arrays
      if (Array.isArray(data[keys[0]])) {
        const summary = {
          _compressed: true,
          tool: toolName,
          total_rows: data.length || keys.length,
          fields: Array.isArray(data[0]) ? data[0] : keys.slice(0, 10),
          row_count: Array.isArray(data) ? data.length : 'object',
          note: 'Compressed summary. Full data was processed in prior turn.'
        };
        return JSON.stringify(summary).substring(0, MAX_SUMMARY);
      }
      // Generic object — keep source metadata + truncated preview
      const summary = {
        _compressed: true,
        tool: toolName,
        source: parsed._source || null,
        keys: keys.slice(0, 10),
        preview: JSON.stringify(data).substring(0, 500),
        note: 'Compressed summary. Full data was processed in prior turn.'
      };
      return JSON.stringify(summary).substring(0, MAX_SUMMARY);
    }

    // Strings (web research results) — keep first 1500 chars
    if (typeof data === 'string') {
      return JSON.stringify({
        _compressed: true,
        tool: toolName,
        preview: data.substring(0, 1500),
        full_length: data.length,
        note: 'Compressed. Full text was processed in prior turn.'
      });
    }
  } catch (e) {
    // If parsing fails, just truncate hard
  }
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
        return cite('Yext Live API', source, timestamp, data.response?.entities || data);
      }

      case 'census_demographics_lookup': {
        const years = [input.year || '2024', '2023'];
        for (const year of years) {
          url = `https://api.census.gov/data/${year}/acs/acs5${input.endpoint}${input.endpoint.includes('?') ? '&' : '?'}key=${process.env.CENSUS_API_KEY}`;
          source = url.replace(process.env.CENSUS_API_KEY, '[KEY]');
          try {
            res = await fetchWithTimeout(url, {}, 60000); // Census can be slow
            if (res.ok) {
              data = await res.json();
              return cite(`Census ACS 5-Year (${year})`, source, timestamp, data);
            }
            console.log(`[Census] ${year} returned ${res.status}, trying fallback...`);
          } catch (err) {
            console.log(`[Census] ${year} failed: ${err.message}, trying fallback...`);
          }
          if (year === years[0] && years[0] === '2023') break; // Already on fallback
        }
        return cite('Census ACS 5-Year', source, timestamp, {
          error: 'Census Bureau API is currently unavailable (both 2024 and 2023 datasets). This is a government service outage — try again in a few minutes.'
        });
      }

      case 'web_research': {
        url = 'https://api.openai.com/v1/responses';
        source = 'OpenAI gpt-4o web_search_preview';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            tools: [{ type: 'web_search_preview' }],
            input: input.research_query
          })
        }, 60000);
        data = await res.json();
        // Extract the text output from the response
        const output = data.output?.filter(o => o.type === 'message')
          .flatMap(o => o.content?.filter(c => c.type === 'output_text').map(c => c.text))
          .join('\n') || JSON.stringify(data.output);
        return cite(source, 'openai.com/v1/responses', timestamp, output);
      }

      case 'geocode_address': {
        url = `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.GOOGLE_MAPS_API_KEY}&address=${input.address}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        return cite('Google Geocoding API', source, timestamp, data.results || data);
      }

      case 'calculate_drive_times': {
        url = `https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}&origins=${input.origins}&destinations=${input.destinations}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        // Flatten into unambiguous origin→destination pairs so the model can't misattribute
        const flat = [];
        const origins = data.origin_addresses || [];
        const dests = data.destination_addresses || [];
        for (let oi = 0; oi < (data.rows || []).length; oi++) {
          for (let di = 0; di < (data.rows[oi].elements || []).length; di++) {
            const el = data.rows[oi].elements[di];
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
        return cite('Google Distance Matrix API', source, timestamp, flat);
      }

      case 'competitor_ratings_reviews': {
        url = `https://maps.googleapis.com/maps/api/place/textsearch/json?key=${process.env.GOOGLE_MAPS_API_KEY}&query=${input.query}`;
        source = url.replace(process.env.GOOGLE_MAPS_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        return cite('Google Places Text Search', source, timestamp, data.results || data);
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
        return cite(source, url.replace(process.env.OUTSCRAPER_API_KEY, '[KEY]'), timestamp, data);
      }

      case 'drive_time_isochrone': {
        url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
        source = 'OpenRouteService Isochrone API';
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': process.env.ORS_API_KEY
          },
          body: JSON.stringify({
            locations: input.locations,
            range: input.range,
            range_type: 'time'
          })
        });
        data = await res.json();
        return cite(source, url, timestamp, data);
      }

      case 'baptist_health_physician_lookup': {
        url = `https://liveapi.yext.com/v2/accounts/me/entities?api_key=${process.env.YEXT_API_KEY}&v=20231201&entityTypes=healthcareProfessional&limit=50&fields=name,c_listOfSpecialties,c_providerTitle,degrees,address,geocodedCoordinate,mainPhone,languages,npi,acceptingNewPatients,c_averageReviewRating,c_reviewCount,officeName,closed&filter=${input.filter}`;
        source = url.replace(process.env.YEXT_API_KEY, '[KEY]');
        res = await fetchWithTimeout(url);
        data = await res.json();
        return cite('Yext Live API (Physicians)', source, timestamp, data.response?.entities || data);
      }

      case 'cdc_health_behaviors': {
        const zips = input.zip_codes.split(',').map(z => z.trim());
        const results = {};
        for (const zip of zips) {
          if (cdcPlacesData[zip]) {
            results[zip] = cdcPlacesData[zip];
          } else {
            results[zip] = { error: `No CDC PLACES data for ZIP ${zip}. Coverage: 195 South Florida ZIPs (Miami-Dade, Broward, Palm Beach, Monroe).` };
          }
        }
        return cite('CDC PLACES 2025 (local data, BRFSS 2023)', 'cdc-places-south-florida.json', timestamp, results);
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[Tool:${name}] Error:`, err.message);
    return cite(name, url || 'N/A', timestamp, { error: err.message });
  }
}

function cite(api, url, timestamp, data) {
  return {
    _source: { api, url, retrieved_at: timestamp },
    data: truncateResult(data)
  };
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

  let fullText = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: session.messages,
      tools
    });

    // Collect the full response
    const response = await stream.finalMessage();

    // Process content blocks
    const assistantContent = response.content;
    let textParts = [];
    let toolCalls = [];

    for (const block of assistantContent) {
      if (block.type === 'text') {
        textParts.push(block.text);
        // Stream text to client
        sendSSE(res, 'delta', { text: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push(block);
      }
    }

    // Append assistant message to session
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

      const result = await executeTool(toolCall.name, toolCall.input);
      const fullContent = JSON.stringify(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: fullContent
      });
      // Store compressed summary for session history (saves tokens on subsequent queries)
      toolSummaries.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: compressToolResult(toolCall.name, fullContent)
      });
    }

    // Send full results for THIS iteration (agent needs complete data to reason)
    session.messages.push({ role: 'user', content: toolResults });

    // After agent processes results, replace with compressed version in history
    // (only compress after the final iteration — during tool loops, keep full data)
    if (iterations > 0) {
      session._pendingCompression = session._pendingCompression || [];
      session._pendingCompression.push({
        index: session.messages.length - 1,
        compressed: toolSummaries
      });
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    sendSSE(res, 'delta', { text: '\n\n*[Max iterations reached. Some data may be incomplete.]*' });
    fullText += '\n\n*[Max iterations reached. Some data may be incomplete.]*';
  }

  // Compress tool results in session history now that the agent is done.
  // This replaces raw JSON (20K+ chars) with compact summaries (2K chars)
  // so subsequent queries don't re-read massive payloads.
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
  return fullText;
}

// ── API Endpoint ─────────────��──────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { query, session_id } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const sessionId = session_id || `anon-${Date.now()}`;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Disable timeout for this SSE connection
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

// ── Legacy endpoint (for backward compatibility during transition) ──────────
app.post('/webhook/market-research', async (req, res) => {
  const { query, session_id } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const sessionId = session_id || `anon-${Date.now()}`;

  try {
    // Non-streaming version for n8n-style JSON response
    const session = getSession(sessionId);
    session.messages.push({ role: 'user', content: query });

    let fullText = '';
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
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
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result)
        });
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

// ── Start ──────���────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  BH Market Research Agent v2 running at http://localhost:${PORT}\n`);
  console.log(`  Tools: ${tools.length} registered`);
  console.log(`  System prompt: ${SYSTEM_PROMPT.length} chars`);
  console.log(`  Streaming: /api/chat (SSE)`);
  console.log(`  Legacy: /webhook/market-research (JSON)\n`);
});
