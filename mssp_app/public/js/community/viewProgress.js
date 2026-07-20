import { PLAYBACK_STATUSES } from "../player/playerState.js";

const STORAGE_KEY = "mssp:viewProgress";
const VIEW_THRESHOLD = 0.35;
const MAX_PLAY_DELTA_SECONDS = 2.5;

export function createViewProgress({
  playerState,
  communitySignals,
  storage = globalThis.localStorage,
  threshold = VIEW_THRESHOLD,
  maxPlayDeltaSeconds = MAX_PLAY_DELTA_SECONDS,
} = {}) {
  if (!playerState || !communitySignals) {
    throw new Error("View progress requires playerState and communitySignals");
  }

  let started = false;
  let unsubscribe = null;
  let activeEpisodeKey = null;
  let lastSampleTime = null;
  let recordInFlight = false;

  function start() {
    if (started) return;
    started = true;
    unsubscribe = playerState.subscribe(handlePlayerState);
  }

  function stop() {
    if (!started) return;
    started = false;
    unsubscribe?.();
    unsubscribe = null;
    activeEpisodeKey = null;
    lastSampleTime = null;
  }

  function handlePlayerState(state) {
    if (!started) return;
    const episodeKey = state?.selectedEpisode?.episodeKey;
    const isPlaying = state?.playbackStatus === PLAYBACK_STATUSES.PLAYING;
    const currentTime = Number(state?.currentTime);
    const duration = Number(state?.duration);

    if (!isPlaying || !episodeKey || !Number.isFinite(duration) || duration <= 0) {
      activeEpisodeKey = null;
      lastSampleTime = null;
      return;
    }

    if (episodeKey !== activeEpisodeKey) {
      activeEpisodeKey = episodeKey;
      lastSampleTime = Number.isFinite(currentTime) ? currentTime : null;
      maybeRecordView(episodeKey, duration);
      return;
    }

    if (!Number.isFinite(currentTime)) return;

    if (Number.isFinite(lastSampleTime)) {
      const delta = currentTime - lastSampleTime;
      if (delta > 0 && delta <= maxPlayDeltaSeconds) {
        addPlayedSeconds(episodeKey, delta);
        maybeRecordView(episodeKey, duration);
      }
    }

    lastSampleTime = currentTime;
  }

  function maybeRecordView(episodeKey, duration) {
    const entry = getEntry(episodeKey);
    if (entry.recorded || recordInFlight) return;
    if (entry.playedSeconds / duration < threshold) return;
    recordInFlight = true;
    void communitySignals.recordView(episodeKey).then((recorded) => {
      if (recorded) markRecorded(episodeKey);
    }).finally(() => {
      recordInFlight = false;
    });
  }

  function addPlayedSeconds(episodeKey, delta) {
    const entry = getEntry(episodeKey);
    if (entry.recorded) return;
    entry.playedSeconds = Math.max(0, entry.playedSeconds + delta);
    entry.updatedAt = Date.now();
    persistEntry(episodeKey, entry);
  }

  function markRecorded(episodeKey) {
    const entry = getEntry(episodeKey);
    entry.recorded = true;
    entry.updatedAt = Date.now();
    persistEntry(episodeKey, entry);
  }

  function getEntry(episodeKey) {
    const store = readStore();
    const existing = store[episodeKey];
    if (existing && typeof existing === "object") {
      return {
        playedSeconds: Number.isFinite(existing.playedSeconds) ? Math.max(0, existing.playedSeconds) : 0,
        recorded: Boolean(existing.recorded),
        updatedAt: Number.isFinite(existing.updatedAt) ? existing.updatedAt : 0,
      };
    }
    return { playedSeconds: 0, recorded: false, updatedAt: 0 };
  }

  function persistEntry(episodeKey, entry) {
    const store = readStore();
    store[episodeKey] = entry;
    writeStore(store);
  }

  function readStore() {
    try {
      const parsed = JSON.parse(storage?.getItem(STORAGE_KEY));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function writeStore(store) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // View progress remains functional for the current session even if persistence fails.
    }
  }

  return { start, stop };
}
