const { SOURCE_BASE_URL, buildUrl } = require("./buildR2Sources");

const NT_SOURCE_PREFIX = "mssp";
const DEFAULT_AUDIO_EXTENSION = "mp3";
const DEFAULT_AUDIO_MIME_TYPE = "audio/mpeg";

function normalizeAudioExtension(extension) {
  const value = String(extension || DEFAULT_AUDIO_EXTENSION).trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(value)) {
    throw new Error(`Invalid R2 override audio extension: ${extension}`);
  }
  return value;
}

function buildObjectKey(episode, extension = DEFAULT_AUDIO_EXTENSION) {
  const ext = normalizeAudioExtension(extension);
  return `${NT_SOURCE_PREFIX}/${episode.date} ${episode.type} Ep. ${episode.episode} - ${episode.title}.${ext}`;
}

function buildR2OverrideSources(episodes, overrides = {}) {
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  const r2Matches = overrides.r2Matches && typeof overrides.r2Matches === "object"
    ? overrides.r2Matches
    : {};
  const sources = {};

  for (const [episodeKey, override] of Object.entries(r2Matches)) {
    const episode = episodeByKey.get(episodeKey);
    if (!episode) {
      throw new Error(`R2 override episodeKey does not match an exported episode: ${episodeKey}`);
    }
    if (episode.collectionKind !== "new") {
      throw new Error(`R2 override is only supported for New Testament episodes: ${episodeKey}`);
    }

    const extension = override?.extension || DEFAULT_AUDIO_EXTENSION;
    const mimeType = override?.mimeType || DEFAULT_AUDIO_MIME_TYPE;
    const objectKey = buildObjectKey(episode, extension);
    sources[episodeKey] = {
      sourceType: "r2_audio",
      objectKey,
      url: buildUrl(objectKey),
      mimeType,
      isOfficial: false,
      credit: "New Testament archival mirror",
    };
  }

  return sources;
}

module.exports = {
  NT_SOURCE_PREFIX,
  buildR2OverrideSources,
};
