const AUTO_MATCH_THRESHOLD = 90;
const AMBIGUITY_MARGIN = 15;

export function normalizePatreonTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    // Patreon often tags posts as "*audio*" / "*vid*" / "=audio=" / "(paytch audio)".
    .replace(/[*_=()\[\]-]{0,3}\b(?:audio|vid|video)\b[*_=()\[\]-]{0,3}/g, " ")
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
  const candidateByGuid = indexCandidatesByGuid(candidates);
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

  // Prefer audio enclosures/titles over video twins when scores tie.
  pairs.sort((left, right) => (
    right.score - left.score
    || mediaPreference(right.candidate) - mediaPreference(left.candidate)
    || left.episode.episodeKey.localeCompare(right.episode.episodeKey)
  ));
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

function indexCandidatesByGuid(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const guid = String(candidate.guid);
    map.set(guid, candidate);
    // Overrides store bare numeric Patreon post ids; feeds sometimes use full URLs.
    const numeric = guid.match(/(\d{6,})(?:\D*)?$/);
    if (numeric) map.set(numeric[1], candidate);
  }
  return map;
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

  const media = mediaPreference(candidate);
  if (media > 0) {
    score += 25;
    reasons.push("audio-preferred");
  } else if (media < 0) {
    score -= 25;
    reasons.push("video-depreferred");
  }

  return { episode, candidate, score, reasons };
}

function isSafeAutoMatch(pair, pairs) {
  const exact = pair.reasons.includes("date-exact") && pair.reasons.includes("title-exact");
  if (!exact && pair.score < AUTO_MATCH_THRESHOLD) return false;

  const episodeCompetitor = bestOtherScore(
    pairs,
    (other) => other.episode.episodeKey === pair.episode.episodeKey
      && other.candidate.guid !== pair.candidate.guid
      && !isWeakerMediaTwin(pair, other),
  );
  const candidateCompetitor = bestOtherScore(
    pairs,
    (other) => other.candidate.guid === pair.candidate.guid && other.episode.episodeKey !== pair.episode.episodeKey,
  );
  return pair.score - episodeCompetitor >= AMBIGUITY_MARGIN
    && pair.score - candidateCompetitor >= AMBIGUITY_MARGIN;
}

function isWeakerMediaTwin(preferred, other) {
  const preferredMedia = mediaPreference(preferred.candidate);
  const otherMedia = mediaPreference(other.candidate);
  if (preferredMedia <= 0 || otherMedia >= 0) return false;
  const preferredTitle = normalizePatreonTitle(preferred.candidate.title);
  const otherTitle = normalizePatreonTitle(other.candidate.title);
  return Boolean(preferredTitle) && preferredTitle === otherTitle;
}

function mediaPreference(candidate) {
  const title = String(candidate?.title || "").toLowerCase();
  const mime = String(candidate?.mimeType || "").toLowerCase();
  const markedAudio = /(?:^|[^a-z])audio(?:[^a-z]|$)/.test(title) || mime.startsWith("audio/");
  const markedVideo = /(?:^|[^a-z])(?:vid|video)(?:[^a-z]|$)/.test(title) || mime.startsWith("video/");
  if (markedAudio && !markedVideo) return 1;
  if (markedVideo && !markedAudio) return -1;
  return 0;
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
