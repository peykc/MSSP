const fs = require("node:fs");
const path = require("node:path");
const { COLLECTIONS, EXPECTED_COUNTS } = require("../src/config/collections");
const { ANTHOLOGY_MARKDOWN, COVERS, PUBLIC_DIR, ROOT_DIR } = require("../src/config/paths");
const { parseAnthology } = require("../src/data/anthologyParser");

const SCHEMA_VERSION = 1;
const DATA_DIR = path.join(PUBLIC_DIR, "data");

function main() {
  const generatedAt = new Date().toISOString();
  const parsed = parseAnthology(ANTHOLOGY_MARKDOWN);
  const counts = deriveCounts(parsed.episodes);
  const warnings = validateExport(parsed, counts);
  const sourceFile = toPortablePath(ANTHOLOGY_MARKDOWN);

  const episodes = parsed.episodes
    .slice()
    .sort((a, b) => a.globalIndex - b.globalIndex)
    .map(toStaticEpisode);

  const payloads = {
    "episodes.json": {
      generatedAt,
      schemaVersion: SCHEMA_VERSION,
      sourceFile,
      collection: "anthology",
      count: episodes.length,
      episodes,
    },
    "collections.json": {
      generatedAt,
      schemaVersion: SCHEMA_VERSION,
      sourceFile,
      total: counts.anthology,
      collections: COLLECTIONS.map((collection) => toStaticCollection(collection, parsed.episodes)),
    },
    "health.json": {
      generatedAt,
      schemaVersion: SCHEMA_VERSION,
      sourceFile,
      mode: "static-export",
      databaseLoaded: false,
      parsedRows: parsed.episodes.length,
      skippedRows: parsed.skippedRows,
      counts,
      warnings,
    },
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [fileName, payload] of Object.entries(payloads)) {
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  console.log(`Exported ${episodes.length} episodes to ${DATA_DIR}`);
  console.log(`Counts: anthology=${counts.anthology}, old=${counts.old}, new=${counts.new}, paytch=${counts.paytch}`);
  if (warnings.length > 0) {
    for (const warning of warnings) console.warn(`[mssp export] ${warning}`);
  }
}

function toStaticEpisode(episode) {
  return {
    id: episode.globalIndex,
    globalIndex: episode.globalIndex,
    episodeKey: episode.episodeKey,
    date: episode.date,
    type: episode.series,
    paytch: episode.isPaytch ? "PAYTCH" : "",
    episode: episode.episodeCode,
    title: episode.title,
    collectionKind: episode.collectionKind,
    coverKind: episode.coverKind,
    coverUrl: `/covers/${episode.coverKind}`,
  };
}

function toStaticCollection(collection, episodes) {
  const matchingEpisodes = episodes.filter(collection.filter);
  const cover = COVERS[collection.coverKind] || {};
  const dates = matchingEpisodes.map((episode) => episode.date).filter(Boolean).sort();

  return {
    id: collection.id,
    name: collection.name,
    shortName: collection.shortName,
    coverUrl: `/covers/${collection.coverKind}`,
    hoverCoverUrl: cover.hoverFile ? `/covers/${collection.coverKind}-hover` : "",
    accent: collection.accent,
    count: matchingEpisodes.length,
    startDate: dates[0] || "",
    endDate: dates[dates.length - 1] || "",
  };
}

function deriveCounts(episodes) {
  return {
    anthology: episodes.length,
    old: episodes.filter((episode) => episode.collectionKind === "old").length,
    new: episodes.filter((episode) => episode.collectionKind === "new").length,
    paytch: episodes.filter((episode) => episode.collectionKind === "paytch").length,
  };
}

function validateExport(parsed, counts) {
  const warnings = [...parsed.warnings];

  for (const [id, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = counts[id] || 0;
    if (actual !== expected) {
      warnings.push(`Expected ${id} count ${expected}, got ${actual}`);
    }
  }

  const keys = new Set();
  for (const episode of parsed.episodes) {
    if (keys.has(episode.episodeKey)) {
      warnings.push(`Duplicate episodeKey ${episode.episodeKey}`);
    }
    keys.add(episode.episodeKey);
  }

  const ordered = parsed.episodes.every((episode, index) => episode.globalIndex === index + 1);
  if (!ordered) {
    warnings.push("Episode globalIndex values are not one-based and contiguous");
  }

  return warnings;
}

function toPortablePath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

main();
