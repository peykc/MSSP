const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

function removeDatabaseFiles(dbPath) {
  for (const filePath of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function openDatabase(dbPath) {
  removeDatabaseFiles(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      global_index INTEGER NOT NULL,
      episode_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      source_path TEXT,
      date TEXT NOT NULL,
      series TEXT NOT NULL,
      is_paytch INTEGER NOT NULL,
      episode_code TEXT NOT NULL,
      title TEXT NOT NULL,
      collection_kind TEXT NOT NULL,
      cover_kind TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      duration_seconds REAL,
      file_size_bytes INTEGER,
      raw_row TEXT
    );

    CREATE INDEX idx_episodes_global ON episodes(global_index);
    CREATE INDEX idx_episodes_collection ON episodes(collection_kind, global_index);
    CREATE INDEX idx_episodes_date ON episodes(date);
    CREATE INDEX idx_episodes_search ON episodes(searchable_text);
    CREATE INDEX idx_episodes_paytch ON episodes(is_paytch);
  `);
  return db;
}

module.exports = {
  openDatabase,
};
