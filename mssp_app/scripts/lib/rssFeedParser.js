const { XMLParser } = require("fast-xml-parser");
const {
  extractEpisodeNumber,
  normalizeMatchTitle,
  normalizeRssTitle,
} = require("./rssTitleNormalize");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

async function fetchFeedCandidates(feed, { ignoreGuids = [] } = {}) {
  const response = await fetch(feed.url);
  if (!response.ok) {
    throw new Error(`RSS fetch failed for ${feed.id} (${feed.url}): HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const items = extractItems(parsed);
  const ignored = new Set(ignoreGuids.map(String));
  const candidates = [];

  for (const item of items) {
    const candidate = normalizeItem(item, feed);
    if (!candidate) continue;
    if (ignored.has(String(candidate.guid))) continue;
    candidates.push(candidate);
  }

  return candidates;
}

function extractItems(parsed) {
  const channel = parsed?.rss?.channel || parsed?.feed;
  if (!channel) return [];

  const items = channel.item || channel.entry;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function normalizeItem(item, feed) {
  const enclosureUrl = getEnclosureUrl(item);
  if (!enclosureUrl) return null;

  const rssTitle = getText(item.title) || "";
  const pubDateRaw = getText(item.pubDate) || getText(item.published) || getText(item.updated);
  const pubDate = pubDateRaw ? toIsoDate(pubDateRaw) : null;
  const guid = getGuid(item) || enclosureUrl;

  return {
    feedId: feed.id,
    feedLabel: feed.label,
    feedIsOfficial: feed.isOfficial === true,
    rssTitle,
    normalizedTitle: normalizeRssTitle(rssTitle),
    pubDate,
    guid: String(guid),
    enclosureUrl,
    mimeType: getEnclosureType(item) || "audio/mpeg",
    durationSeconds: parseDuration(getItunesDuration(item)),
    episodeNumber: extractEpisodeNumber(rssTitle),
  };
}

function getText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value["#text"] !== undefined) return String(value["#text"]);
  return String(value);
}

function getGuid(item) {
  const guid = item.guid ?? item.id;
  return getText(guid);
}

function getEnclosureUrl(item) {
  const enclosure = item.enclosure ?? item.link;
  if (!enclosure) return null;

  if (Array.isArray(enclosure)) {
    for (const entry of enclosure) {
      const url = entry?.["@_url"] || entry?.["@_href"];
      if (url) return String(url);
    }
    return null;
  }

  if (typeof enclosure === "object") {
    return enclosure["@_url"] || enclosure["@_href"] || null;
  }

  return null;
}

function getEnclosureType(item) {
  const enclosure = item.enclosure;
  if (!enclosure) return null;
  if (Array.isArray(enclosure)) {
    return enclosure[0]?.["@_type"] || null;
  }
  return enclosure["@_type"] || null;
}

function getItunesDuration(item) {
  return item["itunes:duration"]
    ?? item.duration
    ?? item["itunes_duration"]
    ?? null;
}

function parseDuration(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);

  const parts = text.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function toIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

module.exports = {
  fetchFeedCandidates,
  parseDuration,
  toIsoDate,
};
