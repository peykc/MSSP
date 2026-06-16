const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_RSS_FEEDS } = require("../rssFeeds.config");

const OVERRIDES_FILE = path.resolve(__dirname, "../../../data/source-overrides.public.json");

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) {
    return { rssMatches: {}, ignoreRssGuids: [] };
  }

  const payload = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  return {
    rssMatches: payload.rssMatches && typeof payload.rssMatches === "object" ? payload.rssMatches : {},
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
  const r2Entries = [];
  const rssEntries = [];
  const urlToKeys = new Map();

  for (const [episodeKey, source] of Object.entries(sources)) {
    if (source.sourceType === "r2_audio") {
      r2Entries.push([episodeKey, source]);
    } else if (source.sourceType === "public_rss_audio") {
      rssEntries.push([episodeKey, source]);
    } else {
      throw new Error(`Unknown sourceType for ${episodeKey}: ${source.sourceType}`);
    }

    if (!episodeByKey.has(episodeKey)) {
      throw new Error(`Source key does not match an exported episodeKey: ${episodeKey}`);
    }
  }

  if (r2Entries.length !== 145) {
    throw new Error(`Expected 145 R2 sources in merged output, got ${r2Entries.length}`);
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

  for (const episodeKey of Object.keys(sources)) {
    const episode = episodeByKey.get(episodeKey);
    const source = sources[episodeKey];
    if (source.sourceType === "r2_audio" && episode.collectionKind !== "old") {
      throw new Error(`R2 source mapped to non-Old Testament episode: ${episodeKey}`);
    }
  }
}

module.exports = {
  loadOverrides,
  validateMergedSources,
};
