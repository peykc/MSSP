import { getSourceStatus } from "./sourceStatus.js";

const STORAGE_KEY = "mssp:playerState";
const SCHEMA_VERSION = 1;

export const PLAYBACK_STATUSES = Object.freeze({
  IDLE: "idle",
  UNAVAILABLE: "unavailable",
  READY: "ready",
  LOADING_SOURCE: "loading_source",
  BUFFERING_PLAYBACK: "buffering_playback",
  PLAYING: "playing",
  PAUSED: "paused",
  ENDED: "ended",
  ERROR: "error",
});

export function createPlayerState({ getPublicSourceForEpisode = () => null } = {}) {
  const listeners = new Set();
  const state = {
    selectedEpisode: null,
    collectionId: null,
    queue: [],
    queueVersion: 0,
    isExpanded: false,
    fullPlayerMode: "player",
    playbackStatus: PLAYBACK_STATUSES.IDLE,
    playbackRequested: false,
    sourceStatus: null,
    source: null,
    currentTime: 0,
    duration: 0,
    playbackError: "",
  };

  function getState() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  }

  function notify() {
    for (const listener of listeners) listener(state);
  }

  function persist() {
    if (!state.selectedEpisode?.episodeKey || !state.collectionId) {
      clearPersistedState();
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        selectedEpisodeKey: state.selectedEpisode.episodeKey,
        collectionId: state.collectionId,
        isExpanded: state.isExpanded,
        fullPlayerMode: state.fullPlayerMode,
      }));
    } catch (error) {
      console.warn("[MSSP] Could not persist player state.", error);
    }
  }

  function loadEpisode({ episode, collectionId, queue, isExpanded = state.isExpanded, fullPlayerMode = state.fullPlayerMode }) {
    const source = getPublicSourceForEpisode(episode);
    state.selectedEpisode = episode;
    state.collectionId = collectionId;
    state.queue = sortQueue(queue);
    state.queueVersion += 1;
    state.isExpanded = Boolean(isExpanded);
    state.fullPlayerMode = normalizeFullPlayerMode(fullPlayerMode);
    state.source = source;
    state.sourceStatus = getSourceStatus(episode, source);
    state.playbackStatus = source ? PLAYBACK_STATUSES.READY : PLAYBACK_STATUSES.UNAVAILABLE;
    state.playbackRequested = false;
    state.currentTime = 0;
    state.duration = 0;
    state.playbackError = "";
    persist();
    notify();
  }

  function beginContinuation({ episode, collectionId = state.collectionId }) {
    const source = getPublicSourceForEpisode(episode);
    state.selectedEpisode = episode;
    state.collectionId = collectionId;
    state.source = source;
    state.sourceStatus = getSourceStatus(episode, source);
    state.playbackStatus = source
      ? PLAYBACK_STATUSES.BUFFERING_PLAYBACK
      : PLAYBACK_STATUSES.UNAVAILABLE;
    state.playbackRequested = Boolean(source);
    state.currentTime = 0;
    state.duration = 0;
    state.playbackError = "";
    notify();
  }

  function refreshSource() {
    if (!state.selectedEpisode) return;
    const source = getPublicSourceForEpisode(state.selectedEpisode);
    state.source = source;
    state.sourceStatus = getSourceStatus(state.selectedEpisode, source);
    state.playbackStatus = source ? PLAYBACK_STATUSES.READY : PLAYBACK_STATUSES.UNAVAILABLE;
    state.playbackRequested = false;
    state.currentTime = 0;
    state.duration = 0;
    state.playbackError = "";
    notify();
  }

  function setQueue(queue) {
    state.queue = sortQueue(queue);
    state.queueVersion += 1;
    notify();
  }

  function persistCurrentState() {
    persist();
  }

  function setPlaybackStatus(playbackStatus) {
    if (state.playbackStatus === playbackStatus) return;
    state.playbackStatus = playbackStatus;
    notify();
  }

  function setPlaybackRequested(playbackRequested) {
    const requested = Boolean(playbackRequested);
    if (state.playbackRequested === requested) return;
    state.playbackRequested = requested;
    notify();
  }

  function setPlaybackError(message) {
    const nextMessage = String(message || "");
    if (state.playbackError === nextMessage) return;
    state.playbackError = nextMessage;
    notify();
  }

  function setTimeline({ currentTime, duration }) {
    state.currentTime = Number.isFinite(currentTime) ? currentTime : 0;
    state.duration = Number.isFinite(duration) ? duration : 0;
    notify();
  }

  function setExpanded(isExpanded) {
    if (!state.selectedEpisode) return;
    state.isExpanded = Boolean(isExpanded);
    persist();
    notify();
  }

  function setFullPlayerMode(fullPlayerMode) {
    if (!state.selectedEpisode) return;
    const nextMode = normalizeFullPlayerMode(fullPlayerMode);
    if (state.fullPlayerMode === nextMode) return;
    state.fullPlayerMode = nextMode;
    persist();
    notify();
  }

  function step(offset) {
    if (!state.selectedEpisode || !state.queue.length) return null;
    const index = state.queue.findIndex((episode) => episode.episodeKey === state.selectedEpisode.episodeKey);
    const nextEpisode = state.queue[index + offset];
    if (!nextEpisode) return null;
    loadEpisode({
      episode: nextEpisode,
      collectionId: state.collectionId,
      queue: state.queue,
    });
    return nextEpisode;
  }

  function getQueuePosition() {
    const index = state.queue.findIndex((episode) => episode.episodeKey === state.selectedEpisode?.episodeKey);
    return {
      index,
      hasPrevious: index > 0,
      hasNext: index >= 0 && index < state.queue.length - 1,
    };
  }

  function getUpNextWindow(limit = 20, { skipEpisode } = {}) {
    const { index, hasPrevious } = getQueuePosition();
    const total = state.queue.length;
    if (index < 0) {
      return {
        index,
        total,
        hasPrevious,
        hasNext: false,
        items: [],
      };
    }

    const current = state.queue[index];
    const upcoming = [];
    let hasNext = false;

    for (let i = index + 1; i < state.queue.length; i += 1) {
      const episode = state.queue[i];
      if (skipEpisode?.(episode)) continue;
      upcoming.push(episode);
      if (upcoming.length >= limit) {
        hasNext = state.queue.slice(i + 1).some((item) => !skipEpisode?.(item));
        break;
      }
    }

    return {
      index,
      total,
      hasPrevious,
      hasNext,
      items: [current, ...upcoming],
    };
  }

  function getNextPlayableEpisode(fromEpisodeKey, isEpisodePlayable) {
    if (!fromEpisodeKey || !state.queue.length || typeof isEpisodePlayable !== "function") return null;
    const index = state.queue.findIndex((episode) => episode.episodeKey === fromEpisodeKey);
    if (index < 0) return null;
    for (let i = index + 1; i < state.queue.length; i += 1) {
      const episode = state.queue[i];
      if (isEpisodePlayable(episode)) return episode;
    }
    return null;
  }

  async function restore(apiClient) {
    const saved = readPersistedState();
    if (!saved) return null;

    try {
      const result = await apiClient.getEpisodes({ collection: saved.collectionId, query: "" });
      const queue = sortQueue(result.episodes || []);
      const episode = queue.find((item) => item.episodeKey === saved.selectedEpisodeKey);
      if (!episode) {
        clearPersistedState();
        return null;
      }
      loadEpisode({
        episode,
        collectionId: saved.collectionId,
        queue,
        isExpanded: saved.isExpanded,
        fullPlayerMode: saved.fullPlayerMode,
      });
      return episode;
    } catch (error) {
      console.warn("[MSSP] Could not restore player state.", error);
      return null;
    }
  }

  return {
    beginContinuation,
    getNextPlayableEpisode,
    getQueuePosition,
    getUpNextWindow,
    getState,
    loadEpisode,
    persistCurrentState,
    refreshSource,
    restore,
    setExpanded,
    setFullPlayerMode,
    setPlaybackError,
    setPlaybackRequested,
    setPlaybackStatus,
    setQueue,
    setTimeline,
    step,
    subscribe,
  };
}

function sortQueue(queue) {
  return [...queue].sort((a, b) => Number(a.globalIndex || 0) - Number(b.globalIndex || 0));
}

function normalizeFullPlayerMode(mode) {
  return mode === "queue" || mode === "transcript" ? mode : "player";
}

function readPersistedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      saved?.schemaVersion !== SCHEMA_VERSION
      || typeof saved.selectedEpisodeKey !== "string"
      || typeof saved.collectionId !== "string"
    ) {
      clearPersistedState();
      return null;
    }
    return saved;
  } catch {
    clearPersistedState();
    return null;
  }
}

function clearPersistedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
