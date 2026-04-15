# Baptist Health Market Research Agent v1.1

## Overview
A chat-based UI for South Florida market research focused on Baptist Health. Users can query information about BH locations, competitor intelligence, demographics, and market positioning.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JavaScript served as static files from `/public`
- **Backend:** Node.js + Express serving static files
- **External Services:**
  - n8n webhook for AI agent orchestration (`https://michaelmora.app.n8n.cloud/webhook/market-research`)
  - Yext Live API for pre-loading Baptist Health facility data
- **Markdown rendering:** Marked.js (CDN)

## Project Structure
```
├── server.js         # Express server (port 5000, host 0.0.0.0)
├── package.json      # npm config, single dependency: express
└── public/
    └── index.html    # Single-page app with all CSS and client-side JS
```

## Key Features
- Session-based response caching (sessionStorage, 50 entries)
- Request deduplication (prevents duplicate in-flight requests)
- Export to PDF (print) and Word document
- Pre-loaded Baptist Health facility data from Yext API

## Running the App
```bash
npm start
```
Runs on `http://0.0.0.0:5000`

## Deployment
- Target: autoscale
- Run command: `node server.js`
