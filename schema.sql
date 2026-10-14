CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,            -- local date, YYYY-MM-DD
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,     -- ISO timestamp, UTC
  wa_message_id TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(day);
CREATE UNIQUE INDEX IF NOT EXISTS entries_msg_pos ON entries(wa_message_id, position);
