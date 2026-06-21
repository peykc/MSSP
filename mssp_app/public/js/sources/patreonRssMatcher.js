const AUTO_MATCH_THRESHOLD = 90;
const AMBIGUITY_MARGIN = 15;

export function normalizePatreonTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/\b(?:mssp|paytch|patreon|bonus|podcast)\b/g, " ")
    .replace(/\b(?:episode|ep)\.?\s*#?\s*\d+(?:\.\d+)?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractEpisodeNumber(value) {
  const match = String(value || "").match(/\b(?:episode|ep)\.?\s*#?\s*(\d+(?:\.\d+)?)\b/i);
  return match?.[1] || null;
}

export function matchPatreonSources({ episodes, candidates, overrides = {} }) {
  const eligibleEpisodes = episodes.filter((episode) => episode?.paytch === "PAYTCH");
  const episodeByKey = new Map(eligibleEpisodes.map((episode) => [episode.episodeKey, episode]));
  const candidateByGuid = new Map(candidates.map((candidate) => [String(candidate.guid), candidate]));
  const assignedEpisodes = new Set();
  const assignedCandidates = new Set();
  const matches = [];

  for (const [episodeKey, override] of Object.entries(overrides)) {
    const episode = episodeByKey.get(episodeKey);
    const candidate = candidateByGuid.get(String(override.guid));
    if (!episode || !candidate || assignedCandidates.has(candidate.guid)) continue;
    matches.push({ episode, candidate, kind: "manual", score: 100 });
    assignedEpisodes.add(episodeKey);
    assignedCandidates.add(candidate.guid);
  }

  const pairs = [];
  for (const episode of eligibleEpisodes) {
    if (assignedEpisodes.has(episode.episodeKey)) continue;
    for (const candidate of candidates) {
      if (assignedCandidates.has(candidate.guid)) continue;
      pairs.push(scorePair(episode, candidate));
    }
  }

  pairs.sort((left, right) => right.score - left.score || left.episode.episodeKey.localeCompare(right.episode.episodeKey));
  for (const pair of pairs) {
    const episodeKey = pair.episode.episodeKey;
    const candidateGuid = pair.candidate.guid;
    if (assignedEpisodes.has(episodeKey) || assignedCandidates.has(candidateGuid)) continue;
    if (!isSafeAutoMatch(pair, pairs)) continue;
    matches.push({ ...pair, kind: "automatic" });
    assignedEpisodes.add(episodeKey);
    assignedCandidates.add(candidateGuid);
  }

  return {
    matches,
    unmatchedEpisodes: eligibleEpisodes.filter((episode) => !assignedEpisodes.has(episode.episodeKey)),
    unmatchedCandidates: candidates.filter((candidate) => !assignedCandidates.has(candidate.guid)),
    summary: {
      eligibleEpisodes: eligibleEpisodes.length,
      feedItems: candidates.length,
      matched: matches.length,
      manualMatched: matches.filter((match) => match.kind === "manual").length,
      automaticMatched: matches.filter((match) => match.kind === "automatic").length,
      unmatchedEpisodes: eligibleEpisodes.length - matches.length,
    },
  };
}

function scorePair(episode, candidate) {
  const reasons = [];
  let score = 0;
  const dayDiff = daysBetween(episode.date, candidate.pubDate);
  if (dayDiff === 0) {
    score += 60;
    reasons.push("date-exact");
  } else if (dayDiff === 1) {
    score += 35;
    reasons.push("date-near");
  }

  const episodeTitle = normalizePatreonTitle(episode.title);
  const candidateTitle = normalizePatreonTitle(candidate.title);
  if (episodeTitle && episodeTitle === candidateTitle) {
    score += 50;
    reasons.push("title-exact");
  } else {
    const overlap = tokenOverlap(episodeTitle, candidateTitle);
    if (overlap >= 0.75) {
      score += 35;
      reasons.push("title-strong");
    } else if (episodeTitle && candidateTitle && (episodeTitle.includes(candidateTitle) || candidateTitle.includes(episodeTitle))) {
      score += 20;
      reasons.push("title-contains");
    }
  }

  const episodeNumber = String(episode.episode || "");
  const candidateNumber = extractEpisodeNumber(candidate.title);
  if (episodeNumber && episodeNumber !== "EX" && candidateNumber === episodeNumber) {
    score += 10;
    reasons.push("episode-number");
  }

  return { episode, candidate, score, reasons };
}

function isSafeAutoMatch(pair, pairs) {
  const exact = pair.reasons.includes("date-exact") && pair.reasons.includes("title-exact");
  if (!exact && pair.score < AUTO_MATCH_THRESHOLD) return false;

  const episodeCompetitor = bestOtherScore(
    pairs,
    (other) => other.episode.episodeKey === pair.episode.episodeKey && other.candidate.guid !== pair.candidate.guid,
  );
  const candidateCompetitor = bestOtherScore(
    pairs,
    (other) => other.candidate.guid === pair.candidate.guid && other.episode.episodeKey !== pair.episode.episodeKey,
  );
  return pair.score - episodeCompetitor >= AMBIGUITY_MARGIN
    && pair.score - candidateCompetitor >= AMBIGUITY_MARGIN;
}

function bestOtherScore(pairs, predicate) {
  let best = 0;
  for (const pair of pairs) {
    if (predicate(pair) && pair.score > best) best = pair.score;
  }
  return best;
}

function daysBetween(left, right) {
  if (!left || !right) return null;
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.abs(Math.round((leftTime - rightTime) / 86400000));
}

function tokenOverlap(left, right) {
  const leftTokens = new Set(String(left || "").split(/\s+/).filter(Boolean));
  const rightTokens = new Set(String(right || "").split(/\s+/).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}
