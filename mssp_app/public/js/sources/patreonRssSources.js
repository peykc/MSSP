import { matchPatreonSources, normalizePatreonTitle } from "./patreonRssMatcher.js";
import { addPatreonR2Sources } from "./patreonR2Sources.js";

const STORAGE_KEY = "mssp:patreonRss";
const STORAGE_SCHEMA_VERSION = 1;
const OVERRIDES_URL = "./data/patreon-rss-overrides.json";
const RSS_WORKER_URL = "https://mssp-rss-proxy.peytonkossex.workers.dev/feed";

export function createPatreonRssSources() {
  let sources = {};
  let summary = null;
  let overridesPromise = null;
  const listeners = new Set();

  function getSourceForEpisode(episode) {
    return episode?.episodeKey ? sources[episode.episodeKey] || null : null;
  }

  function getStoredUrl() {
    try {
      const payload = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return payload?.schemaVersion === STORAGE_SCHEMA_VERSION && typeof payload.feedUrl === "string"
        ? payload.feedUrl
        : "";
    } catch {
      return "";
    }
  }

  async function connect(feedUrl, episodes, { persist = true } = {}) {
    const url = validateFeedUrl(feedUrl);
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => abortController.abort(), 15000);
    let response;
    try {
      response = await fetch(RSS_WORKER_URL, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: url.href }),
        signal: abortController.signal,
      });
    } catch {
      throw privateConnectionError("The MSSP RSS Worker could not retrieve the Patreon feed.");
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      throw privateConnectionError("The Patreon feed request failed. Check that the private link is current.");
    }

    let candidates;
    try {
      candidates = parsePatreonFeed(await response.text());
    } catch {
      throw privateConnectionError("That link did not return a readable podcast RSS feed.");
    }
    if (!candidates.length) {
      throw privateConnectionError("No playable audio items were found in that RSS feed.");
    }

    const overrides = await loadOverrides();
    const result = matchPatreonSources({ episodes, candidates, overrides });
    const nextSources = {};
    for (const match of result.matches) {
      nextSources[match.episode.episodeKey] = {
        sourceType: "patreon_rss",
        url: match.candidate.enclosureUrl,
        mimeType: match.candidate.mimeType || "audio/mpeg",
        feedItemGuid: match.candidate.guid,
        rssTitle: match.candidate.title,
        rssPubDate: match.candidate.pubDate,
        matchKind: match.kind,
        credit: "Your private Patreon RSS feed",
      };
    }

    // These R2 objects are intentionally exposed only after a valid Patreon feed
    // has been retrieved and parsed. They never pass through the RSS Worker.
    const privateR2Matched = addPatreonR2Sources(episodes, nextSources);

    if (persist) persistUrl(url.href);
    sources = nextSources;
    summary = {
      ...result.summary,
      matched: result.summary.matched + privateR2Matched,
      unmatchedEpisodes: Math.max(0, result.summary.unmatchedEpisodes - privateR2Matched),
      privateR2Matched,
    };
    notify();
    return summary;
  }

  async function reconnect(episodes) {
    const storedUrl = getStoredUrl();
    if (!storedUrl) return null;
    return connect(storedUrl, episodes, { persist: false });
  }

  function disconnect() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      throw privateConnectionError("The private RSS connection could not be removed from browser storage.");
    }
    sources = {};
    summary = null;
    notify();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify() {
    for (const listener of listeners) listener({ summary, connected: Boolean(Object.keys(sources).length) });
  }

  return {
    connect,
    disconnect,
    getSourceForEpisode,
    getStoredUrl,
    reconnect,
    subscribe,
  };

  async function loadOverrides() {
    overridesPromise ||= fetch(OVERRIDES_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Override map unavailable");
        return response.json();
      })
      .then(validateOverrides)
      .catch(() => ({}));
    return overridesPromise;
  }
}

export function parsePatreonFeed(xmlText) {
  const documentNode = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  if (documentNode.querySelector("parsererror")) throw new Error("Invalid XML");
  const items = [...documentNode.querySelectorAll("item, entry")];
  const seen = new Set();
  const candidates = [];

  for (const item of items) {
    const enclosure = findEnclosure(item);
    if (!enclosure?.url) continue;
    const title = readChildText(item, ["title"]);
    const pubDate = toIsoDate(readChildText(item, ["pubDate", "published", "updated"]));
    const explicitGuid = readChildText(item, ["guid", "id"]);
    const guid = explicitGuid || `${pubDate || "unknown"}:${normalizePatreonTitle(title)}`;
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    candidates.push({
      guid,
      title,
      pubDate,
      enclosureUrl: enclosure.url,
      mimeType: enclosure.type || "audio/mpeg",
    });
  }
  return candidates;
}

function findEnclosure(item) {
  for (const element of item.children) {
    const localName = element.localName?.toLowerCase();
    const rel = element.getAttribute("rel")?.toLowerCase();
    if (localName === "enclosure" || (localName === "link" && rel === "enclosure") || localName === "content") {
      const url = element.getAttribute("url") || element.getAttribute("href");
      const type = element.getAttribute("type") || "";
      if (url && (!type || type.startsWith("audio/") || /\.(mp3|m4a|aac|ogg|opus)(?:$|\?)/i.test(url))) {
        return { url, type };
      }
    }
  }
  return null;
}

function readChildText(item, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const child of item.children) {
    if (wanted.has(child.localName?.toLowerCase())) return child.textContent?.trim() || "";
  }
  return "";
}

function toIsoDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function validateFeedUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw privateConnectionError("Enter the full HTTPS URL from your Patreon membership page.");
  }
  if (url.protocol !== "https:") {
    throw privateConnectionError("The private RSS link must use HTTPS.");
  }
  if (
    url.hostname !== "www.patreon.com"
    || url.port
    || url.username
    || url.password
    || !url.pathname.startsWith("/rss/")
    || url.pathname.length <= "/rss/".length
  ) {
    throw privateConnectionError("Enter a private RSS link from www.patreon.com/rss/.");
  }
  return url;
}

function validateOverrides(payload) {
  if (payload?.schemaVersion !== 1 || !payload.matches || typeof payload.matches !== "object") return {};
  const safe = {};
  for (const [episodeKey, entry] of Object.entries(payload.matches)) {
    const guid = String(entry?.guid || "").trim();
    const unexpectedFields = Object.keys(entry || {}).filter((key) => !["guid", "reason"].includes(key));
    const looksCredentialed = /[?&](?:auth|token|key|signature|session)=/i.test(guid);
    const looksLikeFeedOrAudio = /\/rss\//i.test(guid) || /\.(?:mp3|m4a|aac|ogg|opus)(?:$|[?#])/i.test(guid);
    if (!guid || guid.length > 500 || unexpectedFields.length || looksCredentialed || looksLikeFeedOrAudio) continue;
    safe[episodeKey] = { guid };
  }
  return safe;
}

function persistUrl(feedUrl) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      feedUrl,
    }));
  } catch {
    throw privateConnectionError("This browser could not save the private RSS link locally.");
  }
}

function privateConnectionError(message) {
  const error = new Error(message);
  error.name = "PatreonRssConnectionError";
  return error;
}
