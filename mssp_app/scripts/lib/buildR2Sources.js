const EXPECTED_R2_COUNT = 145;
const SOURCE_BASE_URL = "https://mssp.pkcollection.net";
const SOURCE_PREFIX = "msspot";

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

function buildR2Sources(episodes) {
  const episodeKeys = new Set(episodes.map((episode) => episode.episodeKey).filter(Boolean));
  const playableEpisodes = episodes.filter(isOldTestamentPublicEpisode);
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

  validateR2Sources({ sources, episodeKeys });
  return sources;
}

function validateR2Sources({ sources, episodeKeys }) {
  const sourceEntries = Object.entries(sources);

  if (sourceEntries.length !== EXPECTED_R2_COUNT) {
    throw new Error(`Expected ${EXPECTED_R2_COUNT} R2 sources, got ${sourceEntries.length}`);
  }

  for (const [episodeKey, source] of sourceEntries) {
    if (!episodeKeys.has(episodeKey)) {
      throw new Error(`R2 source key does not match an exported episodeKey: ${episodeKey}`);
    }
    if (source.sourceType !== "r2_audio") {
      throw new Error(`Expected r2_audio source for ${episodeKey}`);
    }
    if (!source.url.startsWith(`${SOURCE_BASE_URL}/${SOURCE_PREFIX}/`)) {
      throw new Error(`R2 source URL is outside the expected prefix: ${source.url}`);
    }
  }
}

function countR2Sources(sources) {
  return Object.values(sources).filter((source) => source.sourceType === "r2_audio").length;
}

function extractR2Sources(sources) {
  const r2Sources = {};
  for (const [episodeKey, source] of Object.entries(sources)) {
    if (source.sourceType === "r2_audio") {
      r2Sources[episodeKey] = source;
    }
  }
  return r2Sources;
}

module.exports = {
  EXPECTED_R2_COUNT,
  SOURCE_BASE_URL,
  buildR2Sources,
  countR2Sources,
  extractR2Sources,
  validateR2Sources,
};
