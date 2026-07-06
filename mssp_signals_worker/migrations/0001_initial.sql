PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS episode_catalog (
  episode_key TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS favorite_edges (
  episode_key TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (episode_key, client_hash),
  FOREIGN KEY (episode_key) REFERENCES episode_catalog (episode_key) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS favorite_counts (
  episode_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (episode_key) REFERENCES episode_catalog (episode_key) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS favorite_edges_after_insert
AFTER INSERT ON favorite_edges
BEGIN
  INSERT INTO favorite_counts (episode_key, count, updated_at)
  VALUES (NEW.episode_key, 1, unixepoch())
  ON CONFLICT(episode_key) DO UPDATE SET
    count = count + 1,
    updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS favorite_edges_after_delete
AFTER DELETE ON favorite_edges
BEGIN
  UPDATE favorite_counts
  SET count = MAX(count - 1, 0),
      updated_at = unixepoch()
  WHERE episode_key = OLD.episode_key;
END;
