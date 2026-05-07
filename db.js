const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'mra-ledger.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_query TEXT NOT NULL,
    intents TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    model TEXT DEFAULT 'claude-sonnet-4-6',
    iterations INTEGER DEFAULT 0,
    total_input_tokens INTEGER,
    total_output_tokens INTEGER,
    estimated_cost_cents REAL,
    final_response TEXT
  );
  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input_params TEXT,
    status TEXT,
    result_count INTEGER,
    warnings TEXT,
    duration_ms INTEGER,
    raw_result_chars INTEGER,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
  CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);

  -- Permit & Construction Tracker
  CREATE TABLE IF NOT EXISTS permits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_id TEXT UNIQUE,
    project_name TEXT NOT NULL,
    health_system TEXT,
    county TEXT NOT NULL,
    address TEXT,
    facility_type TEXT,
    source TEXT NOT NULL,
    source_url TEXT,
    estimated_value TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    description TEXT,
    first_seen_date TEXT NOT NULL DEFAULT (date('now')),
    last_checked_date TEXT NOT NULL DEFAULT (date('now')),
    last_status_change_date TEXT,
    previous_status TEXT,
    newsletter_last_reported TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    raw_data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_permits_county ON permits(county);
  CREATE INDEX IF NOT EXISTS idx_permits_system ON permits(health_system);
  CREATE INDEX IF NOT EXISTS idx_permits_status ON permits(status);
  CREATE INDEX IF NOT EXISTS idx_permits_active ON permits(is_active);
  CREATE INDEX IF NOT EXISTS idx_permits_first_seen ON permits(first_seen_date);

  CREATE TABLE IF NOT EXISTS permit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    permit_id TEXT NOT NULL,
    changed_field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_date TEXT NOT NULL DEFAULT (datetime('now')),
    change_source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_permit_history_permit ON permit_history(permit_id);
  CREATE INDEX IF NOT EXISTS idx_permit_history_date ON permit_history(changed_date);

  CREATE TABLE IF NOT EXISTS scraper_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    records_found INTEGER DEFAULT 0,
    records_new INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER
  );
`);

const insertRun = db.prepare(`
  INSERT INTO runs (session_id, user_query, intents, model) VALUES (?, ?, ?, ?)
`);
const updateRun = db.prepare(`
  UPDATE runs SET iterations=?, total_input_tokens=?, total_output_tokens=?,
  estimated_cost_cents=?, final_response=? WHERE id=?
`);
const insertToolCall = db.prepare(`
  INSERT INTO tool_calls (run_id, tool_name, input_params, status, result_count, warnings, duration_ms, raw_result_chars)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Permit tracker statements
const insertPermit = db.prepare(`
  INSERT INTO permits (permit_id, project_name, health_system, county, address, facility_type,
    source, source_url, estimated_value, status, description, first_seen_date, last_checked_date,
    last_status_change_date, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), date('now'), ?, ?)
`);
const updatePermit = db.prepare(`
  UPDATE permits SET status=?, estimated_value=?, description=?, last_checked_date=date('now'),
    last_status_change_date=?, previous_status=?, source_url=COALESCE(?, source_url),
    raw_data=? WHERE permit_id=?
`);
const touchPermit = db.prepare(`
  UPDATE permits SET last_checked_date=date('now') WHERE permit_id=?
`);
const getPermitById = db.prepare(`SELECT * FROM permits WHERE permit_id=?`);
const getActivePermits = db.prepare(`SELECT * FROM permits WHERE is_active=1 ORDER BY last_status_change_date DESC, first_seen_date DESC`);
const getPermitsByCounty = db.prepare(`SELECT * FROM permits WHERE county=? AND is_active=1 ORDER BY first_seen_date DESC`);
const insertPermitHistory = db.prepare(`
  INSERT INTO permit_history (permit_id, changed_field, old_value, new_value, change_source)
  VALUES (?, ?, ?, ?, ?)
`);
const getPermitHistory = db.prepare(`SELECT * FROM permit_history WHERE permit_id=? ORDER BY changed_date DESC`);
const insertScraperRun = db.prepare(`
  INSERT INTO scraper_runs (source, status, records_found, records_new, records_updated, error_message, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const markStalePermits = db.prepare(`
  UPDATE permits SET is_active=0, description=COALESCE(description,'') || ' [Auto-deactivated: not confirmed in 6+ weeks]'
  WHERE is_active=1 AND status NOT IN ('completed','denied','withdrawn')
  AND last_checked_date < date('now', '-42 days')
`);

module.exports = {
  db, insertRun, updateRun, insertToolCall,
  insertPermit, updatePermit, touchPermit, getPermitById, getActivePermits, getPermitsByCounty,
  insertPermitHistory, getPermitHistory, insertScraperRun, markStalePermits
};
