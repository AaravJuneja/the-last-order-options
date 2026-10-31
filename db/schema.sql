CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  prompt TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 10 CHECK (duration_seconds BETWEEN 3 AND 300),
  low_seconds INTEGER NOT NULL DEFAULT 3 CHECK (low_seconds BETWEEN 0 AND 30),
  timeout_option INTEGER NOT NULL DEFAULT 0 CHECK (timeout_option IN (0, 1)),
  timeout_toast TEXT NOT NULL DEFAULT 'Time ran out.',
  result_title TEXT NOT NULL DEFAULT 'THE LAST
ORDER',
  options TEXT NOT NULL CHECK (json_valid(options) AND json_array_length(options) = 2),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS questions_position ON questions (position, id);
