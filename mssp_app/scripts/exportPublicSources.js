const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const EXPECTED_SOURCE_COUNT = 145;
const SOURCE_BASE_URL = "https://mssp.pkcollection.net";
const SOURCE_PREFIX = "msspot";
const DATA_DIR = path.resolve(__dirname, "../public/data");
const EPISODES_FILE = path.join(DATA_DIR, "episodes.json");
const SOURCES_FILE = path.join(DATA_DIR, "sources.public.json");

function main() {
  const episodesPayload = JSON.parse(fs.readFileSync(EPISODES_FILE, "utf8"));
  const episodes = Array.isArray(episodesPayload.episodes) ? episodesPayload.episodes : [];
  const playableEpisodes = episodes.filter(isOldTestamentPublicEpisode);
  const episodeKeys = new Set(episodes.map((episode) => episode.episodeKey).filter(Boolean));

  const sources = {};
  for (const episode of playableEpisodes) {
    const objectKey = buildObjectKey(episode);
    sources[episode.episodeKey] = {
      sourceType: "r2_audio",
      objectKey,
      url: buildUrl(objectKey),
      mimeType: "audio/mpeg",
      isOfficial: false,
      credit: "Old Testament archival mirror",
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sourceBaseUrl: SOURCE_BASE_URL,
    sources,
  };

  validateSources({ sources, episodeKeys });
  fs.writeFileSync(SOURCES_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));

  console.log(`Exported ${Object.keys(sources).length} public sources to ${SOURCES_FILE}`);
}

function isOldTestamentPublicEpisode(episode) {
  return episode.collectionKind === "old"
    && episode.type === "MSSPOT"
    && episode.paytch !== "PAYTCH";
}

function buildObjectKey(episode) {
  return `${SOURCE_PREFIX}/${episode.date} ${episode.type} Ep. ${episode.episode} - ${episode.title}.mp3`;
}

function buildUrl(objectKey) {
  return `${SOURCE_BASE_URL}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

function validateSources({ sources, episodeKeys }) {
  const sourceEntries = Object.entries(sources);

  if (sourceEntries.length !== EXPECTED_SOURCE_COUNT) {
    throw new Error(`Expected ${EXPECTED_SOURCE_COUNT} public sources, got ${sourceEntries.length}`);
  }

  for (const [episodeKey, source] of sourceEntries) {
    if (!episodeKeys.has(episodeKey)) {
      throw new Error(`Source key does not match an exported episodeKey: ${episodeKey}`);
    }
    if (!source.url.startsWith(`${SOURCE_BASE_URL}/${SOURCE_PREFIX}/`)) {
      throw new Error(`Source URL is outside the expected R2 prefix: ${source.url}`);
    }
  }
}

main();
