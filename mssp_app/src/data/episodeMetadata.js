const fs = require("node:fs");

const MEDIA_EXTENSIONS = Object.freeze([
  ".mp3",
  ".m4a",
  ".mp4",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".opus",
]);

function stripMediaExtension(filename) {
  const value = String(filename || "");
  const lowered = value.toLowerCase();
  const extension = MEDIA_EXTENSIONS.find((item) => lowered.endsWith(item));
  return extension ? value.slice(0, -extension.length) : value;
}

function enrichEpisodesWithMetadata(episodes, metadataPath) {
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return {
      episodes: episodes.map(withEmptyMetadata),
      diagnostics: {
        matchedCount: 0,
        episodeCount: episodes.length,
        metadataCount: 0,
        missingEpisodeFilenames: episodes.map((episode) => episode.filename).filter(Boolean),
        orphanMetadataFilenames: [],
        duplicateMetadataFilenames: [],
      },
    };
  }

  const rows = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!Array.isArray(rows)) {
    throw new Error(`Anthology metadata must be an array: ${metadataPath}`);
  }

  const metadataByStem = new Map();
  const duplicateMetadataFilenames = [];
  for (const row of rows) {
    const stem = stripMediaExtension(row.filename);
    if (metadataByStem.has(stem)) duplicateMetadataFilenames.push(row.filename);
    metadataByStem.set(stem, {
      filename: String(row.filename || ""),
      durationSeconds: toFiniteNumber(row.duration_seconds),
      fileSizeBytes: toFiniteNumber(row.filesize_bytes),
    });
  }

  const matchedStems = new Set();
  const missingEpisodeFilenames = [];
  const enrichedEpisodes = episodes.map((episode) => {
    const metadata = metadataByStem.get(episode.filenameStem);
    if (!metadata) {
      missingEpisodeFilenames.push(episode.filename || episode.filenameStem);
      return withEmptyMetadata(episode);
    }

    matchedStems.add(episode.filenameStem);
    return {
      ...episode,
      durationSeconds: metadata.durationSeconds,
      fileSizeBytes: metadata.fileSizeBytes,
    };
  });

  return {
    episodes: enrichedEpisodes,
    diagnostics: {
      matchedCount: matchedStems.size,
      episodeCount: episodes.length,
      metadataCount: rows.length,
      missingEpisodeFilenames,
      orphanMetadataFilenames: rows
        .filter((row) => !matchedStems.has(stripMediaExtension(row.filename)))
        .map((row) => row.filename),
      duplicateMetadataFilenames,
    },
  };
}

function withEmptyMetadata(episode) {
  return {
    ...episode,
    durationSeconds: null,
    fileSizeBytes: null,
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  MEDIA_EXTENSIONS,
  enrichEpisodesWithMetadata,
  stripMediaExtension,
};
