const { EXPECTED_COUNTS } = require("../config/collections");
const { parseAnthology } = require("./anthologyParser");

function seedDatabase(db, anthologyPath, metadataPath) {
  const parsed = parseAnthology(anthologyPath, { metadataPath });
  const duplicateKeys = findDuplicateEpisodeKeys(parsed.episodes);
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate authoritative filename stems: ${duplicateKeys.join(", ")}`);
  }
  const insert = db.prepare(`
    INSERT INTO episodes (
      global_index, episode_key, filename, source_path, date, series, is_paytch, episode_code, title,
      collection_kind, cover_kind, searchable_text, duration_seconds, file_size_bytes, raw_row
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN TRANSACTION");
  for (const episode of parsed.episodes) {
    insert.run(
      episode.globalIndex,
      episode.episodeKey,
      episode.filename,
      episode.sourcePath,
      episode.date,
      episode.series,
      episode.isPaytch ? 1 : 0,
      episode.episodeCode,
      episode.title,
      episode.collectionKind,
      episode.coverKind,
      episode.searchableText,
      episode.durationSeconds,
      episode.fileSizeBytes,
      episode.rawRow,
    );
  }
  db.exec("COMMIT");

  return validateSeed(db, parsed);
}

function findDuplicateEpisodeKeys(episodes) {
  const seen = new Set();
  const duplicates = new Set();
  for (const episode of episodes) {
    if (seen.has(episode.episodeKey)) duplicates.add(episode.episodeKey);
    seen.add(episode.episodeKey);
  }
  return [...duplicates];
}

function validateSeed(db, parsed) {
  const warnings = [...parsed.warnings];
  const counts = getDerivedCounts(db);

  for (const [id, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = counts[id] || 0;
    if (actual !== expected) {
      warnings.push(`Expected ${id} count ${expected}, got ${actual}`);
    }
  }

  const duplicates = db.prepare(`
    SELECT episode_key AS episodeKey, COUNT(*) AS count
    FROM episodes
    GROUP BY episode_key
    HAVING COUNT(*) > 1
  `).all();
  for (const duplicate of duplicates) {
    warnings.push(`Duplicate episodeKey ${duplicate.episodeKey} appears ${duplicate.count} times`);
  }

  return {
    sourceFile: parsed.sourceFile,
    parsedRows: parsed.episodes.length,
    skippedRows: parsed.skippedRows,
    counts,
    warnings,
    metadataDiagnostics: parsed.metadataDiagnostics,
  };
}

function getDerivedCounts(db) {
  const rows = db.prepare(`
    SELECT collection_kind AS collection, COUNT(*) AS count
    FROM episodes
    GROUP BY collection_kind
  `).all();
  const counts = {
    anthology: db.prepare("SELECT COUNT(*) AS count FROM episodes").get().count,
  };
  for (const row of rows) {
    counts[row.collection] = row.count;
  }
  return counts;
}

module.exports = {
  seedDatabase,
  getDerivedCounts,
};
