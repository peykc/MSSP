const fs = require("node:fs");
const { fetchFeedCandidates } = require("./rssFeedParser");
const { matchRssSources } = require("./rssMatcher");

async function buildRssSources({ episodes, feeds, overrides }) {
  const feedSummaries = [];
  const allCandidates = [];

  for (const feed of feeds) {
    const candidates = await fetchFeedCandidates(feed, {
      ignoreGuids: overrides.ignoreRssGuids || [],
    });
    feedSummaries.push({
      id: feed.id,
      url: feed.url,
      itemCount: candidates.length,
    });
    allCandidates.push(...candidates);
  }

  const { rssSources, manualOverrideKeys, report } = matchRssSources({
    episodes,
    feeds,
    candidates: allCandidates,
    overrides,
  });

  return {
    rssSources,
    manualOverrideKeys,
    report: {
      feeds: feedSummaries,
      ...report,
    },
  };
}

module.exports = {
  buildRssSources,
};
