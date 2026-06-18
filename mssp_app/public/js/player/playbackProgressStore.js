const STORAGE_KEY = "mssp:playbackProgress";
const SCHEMA_VERSION = 1;
const MIN_SAVE_SECONDS = 5;
const NEAR_END_SECONDS = 30;
const NEAR_END_FRACTION = 0.95;
const MAX_ENTRIES = 1000;

export function isRestorablePosition(currentTime, duration) {
  if (!Number.isFinite(currentTime) || currentTime <= 0) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (currentTime >= duration) return false;
  if (currentTime >= duration - NEAR_END_SECONDS) return false;
  if (currentTime / duration >= NEAR_END_FRACTION) return false;
  return true;
}

export function createPlaybackProgressStore({ onChange } = {}) {
  let positions = readPositions();

  function notifyChange() {
    onChange?.();
  }

  function savePosition({ episodeKey, currentTime, duration }) {
    if (!episodeKey) return;
    if (!Number.isFinite(currentTime) || currentTime < MIN_SAVE_SECONDS) return;
    if (!Number.isFinite(duration) || duration <= 0) return;

    positions[episodeKey] = {
      currentTime,
      duration,
      completed: false,
      updatedAt: Date.now(),
    };
    prunePositions();
    persist();
    notifyChange();
  }

  function getRestorablePosition(episodeKey, duration) {
    if (!episodeKey) return null;
    const saved = positions[episodeKey];
    if (!saved || saved.completed || !Number.isFinite(saved.currentTime)) return null;
    if (!isRestorablePosition(saved.currentTime, duration)) return null;
    return saved.currentTime;
  }

  function getEpisodeProgress(episodeKey) {
    if (!episodeKey) return { status: "none" };
    const saved = positions[episodeKey];
    if (!saved) return { status: "none" };
    if (saved.completed) return { status: "completed" };
    if (
      Number.isFinite(saved.currentTime)
      && saved.currentTime >= MIN_SAVE_SECONDS
      && Number.isFinite(saved.duration)
      && saved.duration > 0
    ) {
      return {
        status: "in-progress",
        fraction: Math.max(0, Math.min(1, saved.currentTime / saved.duration)),
      };
    }
    return { status: "none" };
  }

  function markCompleted(episodeKey) {
    if (!episodeKey) return;
    positions[episodeKey] = {
      completed: true,
      updatedAt: Date.now(),
    };
    prunePositions();
    persist();
    notifyChange();
  }

  function removePosition(episodeKey) {
    if (!episodeKey || !positions[episodeKey]) return;
    delete positions[episodeKey];
    persist();
    notifyChange();
  }

  function prunePositions() {
    const keys = Object.keys(positions);
    if (keys.length <= MAX_ENTRIES) return;

    keys
      .sort((a, b) => (positions[a].updatedAt || 0) - (positions[b].updatedAt || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((key) => {
        delete positions[key];
      });
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        positions,
      }));
    } catch (error) {
      console.warn("[MSSP] Could not persist playback progress.", error);
    }
  }

  return {
    getEpisodeProgress,
    getRestorablePosition,
    markCompleted,
    removePosition,
    savePosition,
  };
}

function readPositions() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.schemaVersion !== SCHEMA_VERSION || typeof saved.positions !== "object" || !saved.positions) {
      clearStoredProgress();
      return {};
    }
    return saved.positions;
  } catch {
    clearStoredProgress();
    return {};
  }
}

function clearStoredProgress() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
