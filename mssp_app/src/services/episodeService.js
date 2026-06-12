const { isKnownCollection } = require("../config/collections");

function createEpisodeService(db) {
  function listEpisodes({ collection = "anthology", query = "" } = {}) {
    if (!isKnownCollection(collection)) {
      return { error: "Unknown collection" };
    }

    const where = [];
    const params = [];

    if (collection !== "anthology") {
      where.push("collection_kind = ?");
      params.push(collection);
    }

    const trimmedQuery = String(query || "").trim();
    if (trimmedQuery) {
      where.push(`(
        title LIKE ?
        OR episode_code LIKE ?
        OR series LIKE ?
        OR CASE WHEN is_paytch = 1 THEN 'PAYTCH Patreon' ELSE 'Public' END LIKE ?
        OR date LIKE ?
        OR searchable_text LIKE ?
      )`);
      const like = `%${trimmedQuery}%`;
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const episodes = db.prepare(`
      SELECT id,
             global_index AS globalIndex,
             episode_key AS episodeKey,
             filename,
             source_path AS sourcePath,
             date,
             series,
             is_paytch AS isPaytch,
             episode_code AS episodeCode,
             title,
             collection_kind AS collectionKind,
             cover_kind AS coverKind,
             searchable_text AS searchableText,
             duration_seconds AS durationSeconds,
             file_size_bytes AS fileSizeBytes,
             raw_row AS rawRow
      FROM episodes
      ${whereSql}
      ORDER BY global_index ASC
    `).all(...params).map(toFrontendEpisode);

    return {
      collection,
      count: episodes.length,
      episodes,
    };
  }

  return {
    listEpisodes,
  };
}

function toFrontendEpisode(episode) {
  const isPaytch = Boolean(episode.isPaytch);
  return {
    id: episode.id,
    globalIndex: episode.globalIndex,
    episodeKey: episode.episodeKey,
    filename: episode.filename,
    sourcePath: episode.sourcePath,
    date: episode.date,
    type: episode.series,
    paytch: isPaytch ? "PAYTCH" : "",
    episode: episode.episodeCode,
    title: episode.title,
    collectionKind: episode.collectionKind,
    coverKind: episode.coverKind,
    coverUrl: `/covers/${episode.coverKind}`,
    durationSeconds: episode.durationSeconds,
    fileSizeBytes: episode.fileSizeBytes,
    searchableText: episode.searchableText,
    rawRow: episode.rawRow,
  };
}

module.exports = {
  createEpisodeService,
  toFrontendEpisode,
};
