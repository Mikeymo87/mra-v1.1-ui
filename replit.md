# Baptist Health Market Research Agent v2.1

## Overview
A Claude Sonnet-powered market research chat app for Baptist Health South Florida. 9 live API tools for demographics, facility/physician lookups, competitors, reviews, and drive times. Direct Anthropic SDK backend with SSE streaming.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JavaScript served from `/public`
- **Backend:** Node.js + Express + Anthropic SDK (direct tool_use, no n8n)
- **Streaming:** Server-Sent Events (SSE) for real-time response rendering
- **External APIs:** Yext, Census, Google Maps, OpenAI, Outscraper, OpenRouteService

## Project Structure
```
├── server.js            # Express backend, 9 tool executors, SSE streaming
├── system-prompt.txt    # 35K char system prompt with 7 workflows
├── package.json         # Dependencies: express, dotenv, @anthropic-ai/sdk
├── CLAUDE.md            # Claude Code context
├── MRA-CAPABILITIES.md  # Marketing Plan GPT handoff doc
├── HANDOFF.md           # Full session changelog and cost estimates
└── public/
    └── index.html       # Chat UI with SSE streaming and markdown rendering
```

## Environment Variables (Secrets)
All 7 required — set in Replit Secrets:
- `ANTHROPIC_API_KEY` — Claude Sonnet
- `YEXT_API_KEY` — BH facilities + physicians
- `CENSUS_API_KEY` — US Census ACS
- `OPENAI_API_KEY` — gpt-4o web search
- `GOOGLE_MAPS_API_KEY` — Geocode, Distance Matrix, Places
- `OUTSCRAPER_API_KEY` — Google Reviews
- `ORS_API_KEY` — OpenRouteService isochrones

## Running
```bash
npm install
npm start
```
Runs on `http://0.0.0.0:5000`

## Deployment
- Target: autoscale
- Run command: `node server.js`
