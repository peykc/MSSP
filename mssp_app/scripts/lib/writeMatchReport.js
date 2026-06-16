const fs = require("node:fs");

function writeMatchReport({ filePath, report }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    feeds: report.feeds || [],
    summary: report.summary,
    lowConfidenceMatches: report.lowConfidenceMatches || [],
    r2OverrideEpisodes: report.r2OverrideEpisodes || [],
    unmatchedEpisodes: report.unmatchedEpisodes || [],
    unmatchedRssItems: report.unmatchedRssItems || [],
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

module.exports = {
  writeMatchReport,
};
