PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visitor_edges (
  client_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visitor_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO visitor_stats (id, total, updated_at)
VALUES (1, 0, unixepoch());

CREATE TRIGGER IF NOT EXISTS visitor_edges_after_insert
AFTER INSERT ON visitor_edges
BEGIN
  UPDATE visitor_stats
  SET total = total + 1,
      updated_at = unixepoch()
  WHERE id = 1;
END;
