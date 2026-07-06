const {
  extractEpisodeNumber,
  normalizeMatchTitle,
  titleContainsOther,
  tokenOverlapRatio,
} = require("./rssTitleNormalize");
const { NT_AUDIO_PROXY_BASE } = require("../rssFeeds.config");

const AUTO_MATCH_THRESHOLD = 80;
const LOW_CONFIDENCE_MIN = 60;
const MEGAPHONE_ENCLOSURE_PATTERN = /^https:\/\/traffic\.megaphone\.fm\/(GLT[A-Za-z0-9]+)\.mp3$/;

function isEligibleEpisode(episode) {
  return episode.collectionKind === "new";
}

function daysBetween(leftDate, rightDate) {
  if (!leftDate || !rightDate) return null;
  const left = new Date(`${leftDate}T00:00:00Z`);
  const right = new Date(`${rightDate}T00:00:00Z`);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return null;
  return Math.abs(Math.round((left - right) / 86400000));
}

function scorePair(episode, candidate) {
  let score = 0;
  const reasons = [];

  const episodeNumber = String(episode.episode || "");
  const candidateNumber = candidate.episodeNumber || extractEpisodeNumber(candidate.rssTitle);
  if (episodeNumber && candidateNumber && episodeNumber === String(candidateNumber)) {
    score += 50;
    reasons.push("episode-number");
  }

  const dayDiff = daysBetween(episode.date, candidate.pubDate);
  if (dayDiff === 0) {
    score += 30;
    reasons.push("date-exact");
  } else if (dayDiff === 1) {
    score += 20;
    reasons.push("date-near");
  }

  const episodeTitleNorm = normalizeMatchTitle(episode.title);
  const candidateTitleNorm = normalizeMatchTitle(candidate.rssTitle);
  if (episodeTitleNorm && candidateTitleNorm && episodeTitleNorm === candidateTitleNorm) {
    score += 30;
    reasons.push("title-strong");
  } else {
    const overlap = tokenOverlapRatio(episode.title, candidate.rssTitle);
    if (overlap >= 0.7) {
      score += 15;
      reasons.push("title-medium");
    } else if (titleContainsOther(episode.title, candidate.rssTitle)) {
      score += 10;
      reasons.push("title-contains");
    }
  }

  return {
    score,
    reasons,
    matchConfidence: Math.min(Number((score / 100).toFixed(2)), 1),
  };
}

function isSafeAutoMatch(pair) {
  const reasons = new Set(pair.reasons || []);

  if (pair.score >= AUTO_MATCH_THRESHOLD) return true;

  if (reasons.has("date-exact") && reasons.has("title-strong")) return true;

  if (reasons.has("episode-number") && reasons.has("title-medium")) return true;

  if (reasons.has("episode-number") && reasons.has("date-near")) return true;

  return false;
}

// Maps a Megaphone enclosure URL onto the mssp_audio_proxy route, preserving the
// numeric ?updated= param (Megaphone bumps it on re-upload, so it doubles as edge
// cache invalidation). Returns null for anything that is not a plain Megaphone
// enclosure so odd entries ship unproxied instead of breaking the build.
function buildProxiedNtUrl(enclosureUrl) {
  let parsed;
  try {
    parsed = new URL(enclosureUrl);
  } catch {
    return null;
  }

  const match = MEGAPHONE_ENCLOSURE_PATTERN.exec(`${parsed.origin}${parsed.pathname}`);
  if (!match) return null;

  for (const key of parsed.searchParams.keys()) {
    if (key !== "updated") return null;
  }
  const updated = parsed.searchParams.get("updated");
  if (updated !== null && !/^\d+$/.test(updated)) return null;

  const suffix = updated !== null ? `?updated=${updated}` : "";
  return `${NT_AUDIO_PROXY_BASE}/nt/${match[1]}.mp3${suffix}`;
}

function buildRssSourceEntry(candidate, matchMeta, feedById) {
  const feed = feedById.get(candidate.feedId);
  const proxiedUrl = buildProxiedNtUrl(candidate.enclosureUrl);
  if (!proxiedUrl) {
    console.warn(`[MSSP] Enclosure does not match the Megaphone pattern; shipping unproxied: ${candidate.enclosureUrl}`);
  }
  return {
    sourceType: "public_rss_audio",
    url: proxiedUrl || candidate.enclosureUrl,
    ...(proxiedUrl ? { upstreamUrl: candidate.enclosureUrl } : {}),
    mimeType: candidate.mimeType || "audio/mpeg",
    isOfficial: feed?.isOfficial === true,
    credit: feed?.label || "Official public podcast RSS",
    feedId: candidate.feedId,
    rssGuid: candidate.guid,
    rssTitle: candidate.rssTitle,
    rssPubDate: candidate.pubDate,
    matchConfidence: matchMeta.matchConfidence,
  };
}

function matchRssSources({ episodes, feeds, candidates, overrides = {} }) {
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const eligibleEpisodes = episodes.filter(isEligibleEpisode);
  const episodeByKey = new Map(episodes.map((episode) => [episode.episodeKey, episode]));
  const candidateByGuid = new Map(candidates.map((candidate) => [`${candidate.feedId}:${candidate.guid}`, candidate]));

  const manualOverrideKeys = new Set(Object.keys(overrides.rssMatches || {}));
  const pairs = [];

  for (const episode of eligibleEpisodes) {
    for (const candidate of candidates) {
      const scored = scorePair(episode, candidate);
      pairs.push({
        episodeKey: episode.episodeKey,
        episode,
        candidate,
        ...scored,
      });
    }
  }

  pairs.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.episodeKey.localeCompare(right.episodeKey);
  });

  const assignedEpisodes = new Set();
  const assignedGuids = new Set();
  const autoMatches = [];
  const lowConfidenceMatches = [];

  for (const pair of pairs) {
    if (assignedEpisodes.has(pair.episodeKey) || assignedGuids.has(`${pair.candidate.feedId}:${pair.candidate.guid}`)) {
      continue;
    }

    if (isSafeAutoMatch(pair)) {
      autoMatches.push(pair);
      assignedEpisodes.add(pair.episodeKey);
      assignedGuids.add(`${pair.candidate.feedId}:${pair.candidate.guid}`);
    } else if (pair.score >= LOW_CONFIDENCE_MIN) {
      lowConfidenceMatches.push({
        episodeKey: pair.episodeKey,
        rssTitle: pair.candidate.rssTitle,
        guid: pair.candidate.guid,
        feedId: pair.candidate.feedId,
        score: pair.score,
        matchConfidence: pair.matchConfidence,
        reasons: pair.reasons,
        reason: "Score below auto-match threshold",
      });
    }
  }

  const manualMatches = [];
  for (const [episodeKey, override] of Object.entries(overrides.rssMatches || {})) {
    const episode = episodeByKey.get(episodeKey);
    if (!episode || !isEligibleEpisode(episode)) {
      throw new Error(`Manual RSS override episodeKey is not eligible: ${episodeKey}`);
    }

    const candidateKey = `${override.feedId}:${override.guid}`;
    const candidate = candidateByGuid.get(candidateKey);
    if (!candidate) {
      throw new Error(`Manual RSS override guid not found in feed candidates: ${episodeKey} -> ${candidateKey}`);
    }

    manualMatches.push({
      episodeKey,
      episode,
      candidate,
      score: 100,
      matchConfidence: 1,
      reasons: ["manual-override"],
      reason: override.reason || "Manual override",
      isManual: true,
    });
    assignedEpisodes.add(episodeKey);
    assignedGuids.add(candidateKey);
  }

  const shippedMatches = [...autoMatches];
  for (const manualMatch of manualMatches) {
    const existingIndex = shippedMatches.findIndex((match) => match.episodeKey === manualMatch.episodeKey);
    if (existingIndex >= 0) {
      shippedMatches[existingIndex] = manualMatch;
    } else {
      shippedMatches.push(manualMatch);
    }
  }

  const rssSources = {};
  for (const match of shippedMatches) {
    rssSources[match.episodeKey] = buildRssSourceEntry(match.candidate, match, feedById);
  }

  const unmatchedEpisodes = eligibleEpisodes
    .filter((episode) => !assignedEpisodes.has(episode.episodeKey))
    .map((episode) => ({
      episodeKey: episode.episodeKey,
      date: episode.date,
      episode: episode.episode,
      title: episode.title,
      reason: "No RSS candidate met auto-match threshold",
    }));

  const unmatchedRssItems = candidates
    .filter((candidate) => !assignedGuids.has(`${candidate.feedId}:${candidate.guid}`))
    .map((candidate) => ({
      feedId: candidate.feedId,
      guid: candidate.guid,
      rssTitle: candidate.rssTitle,
      pubDate: candidate.pubDate,
      enclosureUrl: candidate.enclosureUrl,
      reason: "No eligible anthology episode matched this RSS item",
    }));

  const dedupedLowConfidence = dedupeLowConfidence(lowConfidenceMatches, assignedEpisodes);

  return {
    rssSources,
    manualOverrideKeys,
    report: {
      summary: {
        eligibleEpisodes: eligibleEpisodes.length,
        autoMatched: autoMatches.length,
        manualMatched: manualMatches.length,
        unmatchedEpisodes: unmatchedEpisodes.length,
        unmatchedRssItems: unmatchedRssItems.length,
        lowConfidence: dedupedLowConfidence.length,
      },
      lowConfidenceMatches: dedupedLowConfidence,
      unmatchedEpisodes,
      unmatchedRssItems,
    },
  };
}

function dedupeLowConfidence(matches, assignedEpisodes) {
  const bestByEpisode = new Map();
  for (const match of matches) {
    if (assignedEpisodes.has(match.episodeKey)) continue;
    const existing = bestByEpisode.get(match.episodeKey);
    if (!existing || match.score > existing.score) {
      bestByEpisode.set(match.episodeKey, match);
    }
  }
  return [...bestByEpisode.values()].sort((left, right) => right.score - left.score);
}

module.exports = {
  AUTO_MATCH_THRESHOLD,
  LOW_CONFIDENCE_MIN,
  buildProxiedNtUrl,
  isEligibleEpisode,
  isSafeAutoMatch,
  matchRssSources,
  scorePair,
};
