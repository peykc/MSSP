const OUTBOX_STORAGE_KEY = "mssp:community-favorite-outbox";
const MAX_BATCH_SIZE = 20;
const MAX_OUTBOX_ENTRIES = 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 25_000;
const DEFAULT_ARCHIVE_DEBOUNCE_MS = 350;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
const MAX_CONCURRENT_FAVORITES = 3;
const MAX_BACKGROUND_FAILURES = 3;

const fullNumberFormatter = new Intl.NumberFormat("en-US");
const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function createCommunitySignals({
  apiBase,
  getClientId,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage = globalThis.localStorage,
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  archiveDebounceMs = DEFAULT_ARCHIVE_DEBOUNCE_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
} = {}) {
  if (!apiBase || typeof getClientId !== "function" || typeof fetchImpl !== "function") {
    throw new Error("Community signals requires apiBase, getClientId, and fetch");
  }

  const normalizedApiBase = String(apiBase).replace(/\/+$/, "");
  const signalsByEpisode = new Map();
  const listeners = new Set();
  const trackedScopes = new Map();
  const knownEpisodeKeys = new Set();
  const latestRequestByFieldKey = new Map();
  const favoriteInFlight = new Set();
  const outbox = readOutbox(storage);
  let requestSequence = 0;
  let started = false;
  let refreshTimer = null;
  let archiveDebounceTimer = null;
  let favoriteRetryTimer = null;
  let favoriteRetryIndex = 0;
  let backgroundFailureCount = 0;
  let backgroundPollingSuspended = false;

  const setTimeoutFn = windowRef?.setTimeout?.bind(windowRef) || globalThis.setTimeout;
  const clearTimeoutFn = windowRef?.clearTimeout?.bind(windowRef) || globalThis.clearTimeout;
  const setIntervalFn = windowRef?.setInterval?.bind(windowRef) || globalThis.setInterval;
  const clearIntervalFn = windowRef?.clearInterval?.bind(windowRef) || globalThis.clearInterval;

  function start() {
    if (started) return;
    started = true;
    windowRef?.addEventListener?.("online", handleResume);
    documentRef?.addEventListener?.("visibilitychange", handleVisibilityChange);
    refreshTimer = setIntervalFn(() => {
      void refreshTrackedEpisodes({ background: true });
    }, refreshIntervalMs);
    flushFavoriteOutbox();
  }

  function stop() {
    if (!started) return;
    started = false;
    windowRef?.removeEventListener?.("online", handleResume);
    documentRef?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    if (refreshTimer) clearIntervalFn(refreshTimer);
    if (archiveDebounceTimer) clearTimeoutFn(archiveDebounceTimer);
    if (favoriteRetryTimer) clearTimeoutFn(favoriteRetryTimer);
    refreshTimer = null;
    archiveDebounceTimer = null;
    favoriteRetryTimer = null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(new Set());
    return () => listeners.delete(listener);
  }

  function getEpisodeSignals(episodeKey) {
    const value = signalsByEpisode.get(episodeKey);
    return value ? { stars: value.stars, listeners: value.listeners } : { stars: null, listeners: null };
  }

  function setKnownEpisodeKeys(episodeKeys) {
    knownEpisodeKeys.clear();
    for (const key of uniqueStrings(episodeKeys)) knownEpisodeKeys.add(key);
    pruneOutbox();
    persistOutbox();
    flushFavoriteOutbox();
  }

  function setTrackedEpisodeKeys(scope, episodeKeys) {
    const nextKeys = new Set(uniqueKnownStrings(episodeKeys));
    const scopeName = String(scope);
    const previousKeys = trackedScopes.get(scopeName);
    if (setsEqual(previousKeys, nextKeys)) return;
    trackedScopes.set(scopeName, nextKeys);

    if (scope === "archive") {
      if (archiveDebounceTimer) clearTimeoutFn(archiveDebounceTimer);
      archiveDebounceTimer = setTimeoutFn(() => {
        archiveDebounceTimer = null;
        void loadCountsForEpisodes([...trackedScopes.get("archive") || []]);
      }, archiveDebounceMs);
      return;
    }
    if (nextKeys.size) void loadCountsForEpisodes([...nextKeys], { force: true });
  }

  async function loadCountsForEpisodes(episodeKeys, { force = false, background = false } = {}) {
    const keys = uniqueKnownStrings(episodeKeys);
    if (!keys.length) return { successes: 0, failures: 0 };
    if (background && backgroundPollingSuspended && !force) return { successes: 0, failures: 0 };

    const tasks = [];
    for (const chunk of chunkArray(keys, MAX_BATCH_SIZE)) {
      tasks.push(fetchCountChunk("stars", "/v1/stars/counts", chunk));
      tasks.push(fetchCountChunk("listeners", "/v1/presence/counts", chunk));
    }
    const settled = await Promise.allSettled(tasks);
    const successes = settled.filter((result) => result.status === "fulfilled").length;
    const failures = settled.length - successes;

    if (background) {
      if (successes === 0) {
        backgroundFailureCount += 1;
        if (backgroundFailureCount >= MAX_BACKGROUND_FAILURES) backgroundPollingSuspended = true;
      } else {
        backgroundFailureCount = 0;
        backgroundPollingSuspended = false;
      }
    }
    return { successes, failures };
  }

  function setFavorite(episodeKey, { previousFavorite, favorite } = {}) {
    if (!isKnownEpisode(episodeKey) || typeof favorite !== "boolean") return;
    if (typeof previousFavorite === "boolean" && previousFavorite !== favorite) {
      applyOptimisticFavoriteDelta(episodeKey, favorite ? 1 : -1);
    }
    outbox.set(episodeKey, favorite);
    pruneOutbox();
    persistOutbox();
    flushFavoriteOutbox();
  }

  async function sendPresenceHeartbeat({ episodeKey, playing, keepalive = false } = {}) {
    if (!isKnownEpisode(episodeKey) || typeof playing !== "boolean") return false;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/presence/heartbeat`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: Boolean(keepalive && !playing),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          episodeKey,
          playing,
        }),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (payload?.episodeKey === episodeKey && Number.isFinite(payload.listeners)) {
        updateSignalField(episodeKey, "listeners", normalizeCount(payload.listeners));
      }
      return true;
    } catch {
      return false;
    }
  }

  async function fetchCountChunk(field, pathname, episodeKeys) {
    const sequence = ++requestSequence;
    for (const episodeKey of episodeKeys) {
      latestRequestByFieldKey.set(`${field}\u0000${episodeKey}`, sequence);
    }
    const url = new URL(`${normalizedApiBase}${pathname}`);
    for (const episodeKey of episodeKeys) url.searchParams.append("episode", episodeKey);
    const response = await fetchImpl(url.href, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw new Error("Community count request failed");
    const payload = await response.json();
    const changed = new Set();
    for (const episodeKey of episodeKeys) {
      if (latestRequestByFieldKey.get(`${field}\u0000${episodeKey}`) !== sequence) continue;
      const rawValue = payload?.episodes?.[episodeKey]?.[field];
      if (!Number.isFinite(rawValue)) continue;
      if (setSignalField(episodeKey, field, normalizeCount(rawValue))) changed.add(episodeKey);
    }
    notify(changed);
  }

  function flushFavoriteOutbox() {
    if (!started || !knownEpisodeKeys.size || !outbox.size) return;
    const available = [...outbox.keys()]
      .filter((episodeKey) => !favoriteInFlight.has(episodeKey) && isKnownEpisode(episodeKey))
      .slice(0, MAX_CONCURRENT_FAVORITES);
    for (const episodeKey of available) void sendFavoriteMutation(episodeKey, outbox.get(episodeKey));
  }

  async function sendFavoriteMutation(episodeKey, desiredFavorite) {
    favoriteInFlight.add(episodeKey);
    let succeeded = false;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/stars/toggle`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          episodeKey,
          favorite: desiredFavorite,
        }),
      });
      if (!response.ok) throw new Error("Favorite request failed");
      const payload = await response.json();
      if (payload?.episodeKey !== episodeKey || !Number.isFinite(payload.count)) {
        throw new Error("Favorite response was invalid");
      }
      updateSignalField(episodeKey, "stars", normalizeCount(payload.count));
      if (outbox.get(episodeKey) === desiredFavorite) outbox.delete(episodeKey);
      persistOutbox();
      favoriteRetryIndex = 0;
      succeeded = true;
    } catch {
      scheduleFavoriteRetry();
    } finally {
      favoriteInFlight.delete(episodeKey);
      if (succeeded || outbox.get(episodeKey) !== desiredFavorite) flushFavoriteOutbox();
    }
  }

  function scheduleFavoriteRetry() {
    if (!started || favoriteRetryTimer || !outbox.size) return;
    const delay = retryDelaysMs[Math.min(favoriteRetryIndex, retryDelaysMs.length - 1)] || 60_000;
    favoriteRetryIndex += 1;
    favoriteRetryTimer = setTimeoutFn(() => {
      favoriteRetryTimer = null;
      flushFavoriteOutbox();
    }, delay);
  }

  function applyOptimisticFavoriteDelta(episodeKey, delta) {
    const current = signalsByEpisode.get(episodeKey);
    if (!Number.isFinite(current?.stars)) return;
    updateSignalField(episodeKey, "stars", Math.max(0, current.stars + delta));
  }

  function updateSignalField(episodeKey, field, value) {
    if (setSignalField(episodeKey, field, value)) notify(new Set([episodeKey]));
  }

  function setSignalField(episodeKey, field, value) {
    const current = signalsByEpisode.get(episodeKey) || { stars: null, listeners: null };
    if (current[field] === value) return false;
    signalsByEpisode.set(episodeKey, { ...current, [field]: value });
    return true;
  }

  function refreshTrackedEpisodes({ background = false, force = false } = {}) {
    const keys = new Set();
    for (const scopeKeys of trackedScopes.values()) {
      for (const key of scopeKeys) keys.add(key);
    }
    return loadCountsForEpisodes([...keys], { background, force });
  }

  function handleResume() {
    backgroundFailureCount = 0;
    backgroundPollingSuspended = false;
    favoriteRetryIndex = 0;
    if (favoriteRetryTimer) clearTimeoutFn(favoriteRetryTimer);
    favoriteRetryTimer = null;
    flushFavoriteOutbox();
    void refreshTrackedEpisodes({ force: true });
  }

  function handleVisibilityChange() {
    if (documentRef?.visibilityState === "visible") handleResume();
  }

  function pruneOutbox() {
    for (const [episodeKey, favorite] of outbox) {
      if (typeof favorite !== "boolean" || (knownEpisodeKeys.size && !knownEpisodeKeys.has(episodeKey))) {
        outbox.delete(episodeKey);
      }
    }
    if (outbox.size <= MAX_OUTBOX_ENTRIES) return;
    for (const episodeKey of [...outbox.keys()].slice(MAX_OUTBOX_ENTRIES)) outbox.delete(episodeKey);
  }

  function persistOutbox() {
    try {
      storage?.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(Object.fromEntries(outbox)));
    } catch {
      // Local favorites remain functional even if outbox persistence fails.
    }
  }

  function isKnownEpisode(episodeKey) {
    return typeof episodeKey === "string" && knownEpisodeKeys.has(episodeKey);
  }

  function uniqueKnownStrings(values) {
    return uniqueStrings(values).filter((key) => !knownEpisodeKeys.size || knownEpisodeKeys.has(key));
  }

  function notify(changedKeys) {
    if (!changedKeys.size) return;
    for (const listener of listeners) listener(new Set(changedKeys));
  }

  return {
    start,
    stop,
    subscribe,
    getEpisodeSignals,
    setKnownEpisodeKeys,
    setTrackedEpisodeKeys,
    loadCountsForEpisodes,
    setFavorite,
    sendPresenceHeartbeat,
  };
}

export function formatCommunityCount(value, { compact = false } = {}) {
  if (!Number.isFinite(value)) return "—";
  return (compact ? compactNumberFormatter : fullNumberFormatter).format(normalizeCount(value));
}

export function formatListeningSignal(value, { compact = false } = {}) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return `● ${formatCommunityCount(value, { compact })} listening`;
}

function readOutbox(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(OUTBOX_STORAGE_KEY));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).slice(0, MAX_OUTBOX_ENTRIES));
  } catch {
    return new Map();
  }
}

function uniqueStrings(values) {
  return [...new Set(Array.from(values || []).filter((value) => typeof value === "string" && value))];
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function setsEqual(left, right) {
  if (!left || left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
