const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_RSS_FEEDS } = require("../rssFeeds.config");
const {
  EXPECTED_R2_COUNT,
  SOURCE_BASE_URL,
  SOURCE_PREFIX,
} = require("./buildR2Sources");
const { NT_SOURCE_PREFIX } = require("./buildR2OverrideSources");

const OVERRIDES_FILE = path.resolve(__dirname, "../../../data/source-overrides.public.json");

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) {
    return {
      rssMatches: {},
      r2Matches: {},
      youtubeEmbeds: {},
      ignoreRssGuids: [],
    };
  }

  const payload = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  return {
    rssMatches: payload.rssMatches && typeof payload.rssMatches === "object" ? payload.rssMatches : {},
    r2Matches: payload.r2Matches && typeof payload.r2Matches === "object" ? payload.r2Matches : {},
    youtubeEmbeds: payload.youtubeEmbeds && typeof payload.youtubeEmbeds === "object" ? payload.youtubeEmbeds : {},
    ignoreRssGuids: Array.isArray(payload.ignoreRssGuids) ? payload.ignoreRssGuids : [],
  };
}

function validateMergedSources({
  sources,
  episodes,
  feeds = PUBLIC_RSS_FEEDS,
  manualOverrideKeys = new Set(),
}) {
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  const feedIds = new Set(feeds.map((feed) => feed.id));
  const otR2Entries = [];
  const ntR2Entries = [];
  const rssEntries = [];
  const urlToKeys = new Map();

  for (const [episodeKey, source] of Object.entries(sources)) {
    const episode = episodeByKey.get(episodeKey);
    if (!episode) {
      throw new Error(`Source key does not match an exported episodeKey: ${episodeKey}`);
    }

    if (source.sourceType === "r2_audio") {
      if (episode.collectionKind === "old") {
        otR2Entries.push([episodeKey, source]);
      } else if (episode.collectionKind === "new") {
        ntR2Entries.push([episodeKey, source]);
      } else {
        throw new Error(`R2 source mapped to unsupported collection: ${episodeKey}`);
      }
    } else if (source.sourceType === "public_rss_audio") {
      rssEntries.push([episodeKey, source]);
    } else {
      throw new Error(`Unknown sourceType for ${episodeKey}: ${source.sourceType}`);
    }
  }

  if (otR2Entries.length !== EXPECTED_R2_COUNT) {
    throw new Error(`Expected ${EXPECTED_R2_COUNT} Old Testament R2 sources, got ${otR2Entries.length}`);
  }

  for (const [episodeKey, source] of otR2Entries) {
    if (!source.url.startsWith(`${SOURCE_BASE_URL}/${SOURCE_PREFIX}/`)) {
      throw new Error(`Old Testament R2 URL is outside the expected prefix: ${source.url}`);
    }
  }

  for (const [episodeKey, source] of ntR2Entries) {
    if (!source.url.startsWith(`${SOURCE_BASE_URL}/${NT_SOURCE_PREFIX}/`)) {
      throw new Error(`New Testament R2 override URL is outside the expected prefix: ${source.url}`);
    }
    if (!source.url || !String(source.url).trim()) {
      throw new Error(`New Testament R2 source missing url: ${episodeKey}`);
    }
  }

  for (const [episodeKey, source] of rssEntries) {
    const episode = episodeByKey.get(episodeKey);

    if (!source.url || !String(source.url).trim()) {
      throw new Error(`public_rss_audio source missing url: ${episodeKey}`);
    }
    if (!source.rssGuid || !String(source.rssGuid).trim()) {
      throw new Error(`public_rss_audio source missing rssGuid: ${episodeKey}`);
    }
    if (!source.feedId || !feedIds.has(source.feedId)) {
      throw new Error(`public_rss_audio source has invalid feedId: ${episodeKey} -> ${source.feedId}`);
    }
    if (episode.collectionKind !== "new") {
      throw new Error(`public_rss_audio source key is not a New Testament episode: ${episodeKey}`);
    }

    const url = String(source.url);
    const keysForUrl = urlToKeys.get(url) || [];
    keysForUrl.push(episodeKey);
    urlToKeys.set(url, keysForUrl);
  }

  for (const [url, keys] of urlToKeys.entries()) {
    if (keys.length <= 1) continue;
    const allManual = keys.every((episodeKey) => manualOverrideKeys.has(episodeKey));
    if (!allManual) {
      throw new Error(`Duplicate RSS enclosure URL shipped for multiple episodes: ${url} -> ${keys.join(", ")}`);
    }
  }
}

module.exports = {
  loadOverrides,
  validateMergedSources,
};
