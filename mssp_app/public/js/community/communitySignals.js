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

export const VIEW_EYE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 512 512" fill="currentColor">
    <path d="M0,226v32c128,192,384,192,512,0v-32C384,34,128,34,0,226z M256,370c-70.7,0-128-57.3-128-128s57.3-128,128-128s128,57.3,128,128S326.7,370,256,370z M256,170c0-8.3,1.7-16.1,4.3-23.6c-1.5-0.1-2.8-0.4-4.3-0.4c-53,0-96,43-96,96s43,96,96,96c53,0,96-43,96-96c0-1.5-0.4-2.8-0.4-4.3c-7.4,2.6-15.3,4.3-23.6,4.3C288.2,242,256,209.8,256,170z"></path>
  </svg>
`;

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
  const episodeListeners = new Set();
  const onlineListeners = new Set();
  const visitorListeners = new Set();
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
  let listeningActive = false;
  let onlineCount = null;
  let visitorTotal = null;
  let latestOnlineRequest = 0;

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
      if (!shouldPoll()) return;
      void refreshTrackedEpisodes({ background: true });
      void refreshOnlineCount({ background: true });
    }, refreshIntervalMs);
    void refreshOnlineCount({ force: true });
    void recordVisitor();
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
    episodeListeners.add(listener);
    listener(new Set());
    return () => episodeListeners.delete(listener);
  }

  function subscribeOnline(listener) {
    onlineListeners.add(listener);
    listener(onlineCount);
    return () => onlineListeners.delete(listener);
  }

  function subscribeVisitors(listener) {
    visitorListeners.add(listener);
    listener(visitorTotal);
    return () => visitorListeners.delete(listener);
  }

  function getOnlineCount() {
    return onlineCount;
  }

  function getVisitorTotal() {
    return visitorTotal;
  }

  function setListeningActive(next) {
    const listening = Boolean(next);
    if (listeningActive === listening) return;
    listeningActive = listening;
    if (!started || !listening || !shouldPoll()) return;
    backgroundFailureCount = 0;
    backgroundPollingSuspended = false;
    void refreshTrackedEpisodes({ background: true });
    void refreshOnlineCount({ background: true });
  }

  function shouldPoll() {
    return documentRef?.visibilityState !== "hidden" || listeningActive;
  }

  function getEpisodeSignals(episodeKey) {
    const value = signalsByEpisode.get(episodeKey);
    return value ? { stars: value.stars, views: value.views } : { stars: null, views: null };
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
        if (!shouldPoll()) return;
        void loadCountsForEpisodes([...trackedScopes.get("archive") || []]);
      }, archiveDebounceMs);
      return;
    }
    if (nextKeys.size && shouldPoll()) void loadCountsForEpisodes([...nextKeys], { force: true });
  }

  async function loadCountsForEpisodes(episodeKeys, { force = false, background = false } = {}) {
    const keys = uniqueKnownStrings(episodeKeys);
    if (!keys.length) return { successes: 0, failures: 0 };
    if (!force && !shouldPoll()) return { successes: 0, failures: 0 };
    if (background && backgroundPollingSuspended && !force) return { successes: 0, failures: 0 };

    const tasks = [];
    for (const chunk of chunkArray(keys, MAX_BATCH_SIZE)) {
      tasks.push(fetchCountChunk("stars", "/v1/stars/counts", chunk));
      tasks.push(fetchCountChunk("views", "/v1/views/counts", chunk));
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

  async function recordView(episodeKey) {
    if (!isKnownEpisode(episodeKey)) return false;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/views/record`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          episodeKey,
        }),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (payload?.episodeKey === episodeKey && Number.isFinite(payload.views)) {
        updateSignalField(episodeKey, "views", normalizeCount(payload.views));
      }
      return payload?.counted === true;
    } catch {
      return false;
    }
  }

  async function recordVisitor() {
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/visitors/record`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
        }),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (Number.isFinite(payload.total)) {
        setVisitorTotal(normalizeCount(payload.total));
      }
      return payload?.counted === true;
    } catch {
      return false;
    }
  }

  async function refreshVisitorTotal({ force = false } = {}) {
    if (!force && !shouldPoll()) return false;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/visitors/total`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (!Number.isFinite(payload.total)) throw new Error("Visitor total response was invalid");
      setVisitorTotal(normalizeCount(payload.total));
      return true;
    } catch {
      return false;
    }
  }

  async function sendOnlineHeartbeat({ online, keepalive = false } = {}) {
    if (typeof online !== "boolean") return false;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/presence/heartbeat`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        keepalive: Boolean(keepalive && !online),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          online,
        }),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (Number.isFinite(payload.online)) {
        setOnlineCount(normalizeCount(payload.online));
      }
      return true;
    } catch {
      return false;
    }
  }

  async function refreshOnlineCount({ background = false, force = false } = {}) {
    if (!force && !shouldPoll()) return false;
    if (background && backgroundPollingSuspended && !force) return false;
    const sequence = ++requestSequence;
    latestOnlineRequest = sequence;
    try {
      const response = await fetchImpl(`${normalizedApiBase}/v1/presence/online`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) throw new Error("Online count request failed");
      const payload = await response.json();
      if (latestOnlineRequest !== sequence) return true;
      if (!Number.isFinite(payload.online)) throw new Error("Online count response was invalid");
      setOnlineCount(normalizeCount(payload.online));
      if (background) {
        backgroundFailureCount = 0;
        backgroundPollingSuspended = false;
      }
      return true;
    } catch {
      if (background) {
        backgroundFailureCount += 1;
        if (backgroundFailureCount >= MAX_BACKGROUND_FAILURES) backgroundPollingSuspended = true;
      }
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
    const current = signalsByEpisode.get(episodeKey) || { stars: null, views: null };
    if (current[field] === value) return false;
    signalsByEpisode.set(episodeKey, { ...current, [field]: value });
    return true;
  }

  function setOnlineCount(value) {
    if (onlineCount === value) return;
    onlineCount = value;
    for (const listener of onlineListeners) listener(onlineCount);
  }

  function setVisitorTotal(value) {
    if (visitorTotal === value) return;
    visitorTotal = value;
    for (const listener of visitorListeners) listener(visitorTotal);
  }

  function refreshTrackedEpisodes({ background = false, force = false } = {}) {
    if (!force && !shouldPoll()) return Promise.resolve({ successes: 0, failures: 0 });
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
    void refreshOnlineCount({ force: true });
    void refreshVisitorTotal({ force: true });
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
    for (const listener of episodeListeners) listener(new Set(changedKeys));
  }

  return {
    start,
    stop,
    subscribe,
    subscribeOnline,
    subscribeVisitors,
    getOnlineCount,
    getVisitorTotal,
    setListeningActive,
    getEpisodeSignals,
    setKnownEpisodeKeys,
    setTrackedEpisodeKeys,
    loadCountsForEpisodes,
    setFavorite,
    recordView,
    recordVisitor,
    sendOnlineHeartbeat,
    refreshOnlineCount,
    refreshVisitorTotal,
  };
}

export function formatCommunityCount(value, { compact = false } = {}) {
  if (!Number.isFinite(value)) return "—";
  return (compact ? compactNumberFormatter : fullNumberFormatter).format(normalizeCount(value));
}

export function formatViewSignal(value, { compact = false } = {}) {
  return formatCommunityCount(value, { compact });
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
