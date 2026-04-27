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

module.exports = { db, insertRun, updateRun, insertToolCall };
