const { SOURCE_BASE_URL, buildUrl } = require("./buildR2Sources");

const NT_SOURCE_PREFIX = "mssp";

function buildObjectKey(episode) {
  return `${NT_SOURCE_PREFIX}/${episode.date} ${episode.type} Ep. ${episode.episode} - ${episode.title}.mp3`;
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

    const objectKey = buildObjectKey(episode);
    sources[episodeKey] = {
      sourceType: "r2_audio",
      objectKey,
      url: buildUrl(objectKey),
      mimeType: "audio/mpeg",
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
