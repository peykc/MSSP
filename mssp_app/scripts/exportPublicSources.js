const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_RSS_FEEDS } = require("./rssFeeds.config");
const {
  SOURCE_BASE_URL,
  buildR2Sources,
  EXPECTED_R2_COUNT,
} = require("./lib/buildR2Sources");
const { buildR2OverrideSources } = require("./lib/buildR2OverrideSources");
const { buildRssSources } = require("./lib/buildRssSources");
const { loadOverrides, validateMergedSources } = require("./lib/validateMergedSources");
const { writeSourcesPayload } = require("./lib/writeSourcesPayload");
const { writeMatchReport } = require("./lib/writeMatchReport");

const DATA_DIR = path.resolve(__dirname, "../public/data");
const EPISODES_FILE = path.join(DATA_DIR, "episodes.json");
const SOURCES_FILE = path.join(DATA_DIR, "sources.public.json");
const REPORT_FILE = path.join(DATA_DIR, "source-match-report.json");

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const episodesPayload = JSON.parse(fs.readFileSync(EPISODES_FILE, "utf8"));
  const episodes = Array.isArray(episodesPayload.episodes) ? episodesPayload.episodes : [];
  const overrides = loadOverrides();

  let otR2Sources;
  let ntR2Sources;
  let rssSources = {};
  let report = null;
  let manualOverrideKeys = new Set();

  if (flags.rssOnly) {
    otR2Sources = loadExistingOtR2Sources(SOURCES_FILE, episodes);
  } else {
    otR2Sources = buildR2Sources(episodes);
  }

  ntR2Sources = buildR2OverrideSources(episodes, overrides);

  if (!flags.r2Only) {
    try {
      const rssResult = await buildRssSources({
        episodes,
        feeds: PUBLIC_RSS_FEEDS,
        overrides,
      });
      rssSources = rssResult.rssSources;
      report = rssResult.report;
      manualOverrideKeys = rssResult.manualOverrideKeys;
    } catch (error) {
      if (!flags.allowRssFailure) throw error;

      console.error(`[MSSP] RSS export failed: ${error.message}`);
      if (flags.rssOnly) {
        rssSources = extractRssSources(loadExistingSourcesPayload(SOURCES_FILE).sources);
        report = buildFailureReport(error, rssSources);
      } else {
        rssSources = {};
        report = buildFailureReport(error, rssSources);
      }
    }
  }

  const mergedSources = mergeSources(otR2Sources, ntR2Sources, rssSources);
  validateMergedSources({
    sources: mergedSources,
    episodes,
    feeds: PUBLIC_RSS_FEEDS,
    manualOverrideKeys,
  });

  writeSourcesPayload({
    filePath: SOURCES_FILE,
    sources: mergedSources,
    sourceBaseUrl: SOURCE_BASE_URL,
  });

  if (report) {
    report = enrichMatchReport({
      report,
      episodes,
      ntR2Sources,
      rssSources,
      mergedSources,
      overrides,
    });
    writeMatchReport({ filePath: REPORT_FILE, report });
  }

  const otR2Count = countOtR2Sources(mergedSources, episodes);
  const ntR2Count = Object.keys(ntR2Sources).length;
  const rssEntries = Object.values(mergedSources).filter((source) => source.sourceType === "public_rss_audio");
  const rssCount = rssEntries.length;
  const proxiedCount = rssEntries.filter((source) => Boolean(source.upstreamUrl)).length;
  console.log(
    `Exported ${Object.keys(mergedSources).length} public sources `
    + `(${otR2Count} R2 OT, ${ntR2Count} R2 NT, ${rssCount} RSS, ${proxiedCount} proxied) to ${SOURCES_FILE}`,
  );
  if (proxiedCount !== rssCount) {
    console.warn(`[MSSP] ${rssCount - proxiedCount} RSS source(s) shipped without the audio proxy rewrite`);
  }

  if (report?.summary) {
    const { summary } = report;
    console.log(
      `RSS match summary: eligible=${summary.eligibleEpisodes}, auto=${summary.autoMatched}, `
      + `manual=${summary.manualMatched}, lowConfidence=${summary.lowConfidence}, `
      + `unmatchedEpisodes=${summary.unmatchedEpisodes}, unmatchedRssItems=${summary.unmatchedRssItems}`,
    );
    console.log(
      `New Testament source coverage: rss=${summary.rssMatched}, `
      + `r2Overrides=${summary.r2OverrideMatched}, playable=${summary.playableNewTestament}, `
      + `unresolved=${summary.unresolvedNewTestament}`,
    );
  }
}

function parseFlags(argv) {
  return {
    r2Only: argv.includes("--r2-only"),
    rssOnly: argv.includes("--rss-only"),
    allowRssFailure: argv.includes("--allow-rss-failure"),
  };
}

function loadExistingSourcesPayload(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`--rss-only requires existing sources file: ${filePath}`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload?.schemaVersion !== 1 || !payload.sources || typeof payload.sources !== "object") {
    throw new Error(`--rss-only requires a valid sources.public.json at ${filePath}`);
  }

  return payload;
}

function loadExistingOtR2Sources(filePath, episodes) {
  const payload = loadExistingSourcesPayload(filePath);
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  const otR2Sources = {};

  for (const [episodeKey, source] of Object.entries(payload.sources)) {
    if (source.sourceType !== "r2_audio") continue;
    const episode = episodeByKey.get(episodeKey);
    if (episode?.collectionKind === "old") {
      otR2Sources[episodeKey] = source;
    }
  }

  if (Object.keys(otR2Sources).length !== EXPECTED_R2_COUNT) {
    throw new Error(
      `--rss-only requires exactly ${EXPECTED_R2_COUNT} existing Old Testament R2 sources, `
      + `got ${Object.keys(otR2Sources).length}`,
    );
  }

  return otR2Sources;
}

function countOtR2Sources(sources, episodes) {
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  return Object.keys(sources).filter((episodeKey) => {
    const source = sources[episodeKey];
    return source.sourceType === "r2_audio" && episodeByKey.get(episodeKey)?.collectionKind === "old";
  }).length;
}

function extractRssSources(sources) {
  const rssSources = {};
  for (const [episodeKey, source] of Object.entries(sources)) {
    if (source.sourceType === "public_rss_audio") {
      rssSources[episodeKey] = source;
    }
  }
  return rssSources;
}

function mergeSources(otR2Sources, ntR2Sources, rssSources) {
  const merged = { ...otR2Sources };

  for (const [episodeKey, source] of Object.entries(ntR2Sources)) {
    if (merged[episodeKey]) {
      throw new Error(`Collision: episodeKey has both Old Testament R2 and New Testament R2 source: ${episodeKey}`);
    }
    merged[episodeKey] = source;
  }

  for (const [episodeKey, source] of Object.entries(rssSources)) {
    if (merged[episodeKey]) {
      throw new Error(`Collision: episodeKey has both R2 and RSS source: ${episodeKey}`);
    }
    merged[episodeKey] = source;
  }

  return merged;
}

function enrichMatchReport({ report, episodes, ntR2Sources, rssSources, mergedSources, overrides = {} }) {
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  const eligibleEpisodes = episodes.filter((episode) => episode.collectionKind === "new");
  const r2Matches = overrides.r2Matches && typeof overrides.r2Matches === "object"
    ? overrides.r2Matches
    : {};

  const r2OverrideEpisodes = Object.keys(ntR2Sources)
    .map((episodeKey) => {
      const episode = episodeByKey.get(episodeKey);
      const source = ntR2Sources[episodeKey];
      return {
        episodeKey,
        date: episode?.date || "",
        episode: episode?.episode || "",
        title: episode?.title || "",
        reason: r2Matches[episodeKey]?.reason || "New Testament archival R2 fallback",
        sourceType: source.sourceType,
        objectKey: source.objectKey,
        url: source.url,
        credit: source.credit,
      };
    })
    .sort((left, right) => {
      const leftEpisode = episodeByKey.get(left.episodeKey);
      const rightEpisode = episodeByKey.get(right.episodeKey);
      return Number(leftEpisode?.globalIndex || 0) - Number(rightEpisode?.globalIndex || 0);
    });

  const unresolvedEpisodes = eligibleEpisodes
    .filter((episode) => !mergedSources[episode.episodeKey])
    .map((episode) => ({
      episodeKey: episode.episodeKey,
      date: episode.date,
      episode: episode.episode,
      title: episode.title,
      reason: "No public RSS or New Testament R2 fallback source is available",
    }));

  const rssMatched = Object.keys(rssSources).length;
  const r2OverrideMatched = Object.keys(ntR2Sources).length;

  return {
    ...report,
    summary: {
      ...report.summary,
      eligibleEpisodes: eligibleEpisodes.length,
      rssMatched,
      r2OverrideMatched,
      playableNewTestament: rssMatched + r2OverrideMatched,
      unmatchedEpisodes: unresolvedEpisodes.length,
      unresolvedEpisodes: unresolvedEpisodes.length,
      unresolvedNewTestament: unresolvedEpisodes.length,
    },
    r2OverrideEpisodes,
    unmatchedEpisodes: unresolvedEpisodes,
  };
}

function buildFailureReport(error, rssSources) {
  return {
    feeds: PUBLIC_RSS_FEEDS.map((feed) => ({ id: feed.id, url: feed.url, itemCount: 0 })),
    summary: {
      eligibleEpisodes: 360,
      autoMatched: Object.keys(rssSources).length,
      manualMatched: 0,
      unmatchedEpisodes: null,
      unmatchedRssItems: null,
      lowConfidence: 0,
      rssFailure: error.message,
    },
    lowConfidenceMatches: [],
    unmatchedEpisodes: [],
    unmatchedRssItems: [],
  };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
