import { getSourceStatus } from "./sourceStatus.js";

const STORAGE_KEY = "mssp:playerState";
const AUTOPLAY_STORAGE_KEY = "mssp:playerAutoplay:v1";
const SCHEMA_VERSION = 1;

export const PLAYBACK_STATUSES = Object.freeze({
  UNAVAILABLE: "unavailable",
  READY: "ready",
  LOADING: "loading",
  BUFFERING: "buffering",
  PLAYING: "playing",
  PAUSED: "paused",
  ERROR: "error",
});

export function createPlayerState({ getPublicSourceForEpisode = () => null } = {}) {
  const listeners = new Set();
  const state = {
    selectedEpisode: null,
    collectionId: null,
    queue: [],
    isExpanded: false,
    playbackStatus: PLAYBACK_STATUSES.UNAVAILABLE,
    sourceStatus: null,
    source: null,
    currentTime: 0,
    duration: 0,
    playbackError: "",
    autoplayEnabled: readAutoplayPreference(),
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
      }));
    } catch (error) {
      console.warn("[MSSP] Could not persist player state.", error);
    }
  }

  function loadEpisode({ episode, collectionId, queue, isExpanded = state.isExpanded }) {
    const source = getPublicSourceForEpisode(episode);
    state.selectedEpisode = episode;
    state.collectionId = collectionId;
    state.queue = sortQueue(queue);
    state.isExpanded = Boolean(isExpanded);
    state.source = source;
    state.sourceStatus = getSourceStatus(episode, source);
    state.playbackStatus = source ? PLAYBACK_STATUSES.READY : PLAYBACK_STATUSES.UNAVAILABLE;
    state.currentTime = 0;
    state.duration = 0;
    state.playbackError = "";
    persist();
    notify();
  }

  function setQueue(queue) {
    state.queue = sortQueue(queue);
    notify();
  }

  function setPlaybackStatus(playbackStatus) {
    state.playbackStatus = playbackStatus;
    notify();
  }

  function setPlaybackError(message) {
    state.playbackError = String(message || "");
    notify();
  }

  function setAutoplayEnabled(enabled) {
    state.autoplayEnabled = Boolean(enabled);
    persistAutoplayPreference(state.autoplayEnabled);
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
      });
      return episode;
    } catch (error) {
      console.warn("[MSSP] Could not restore player state.", error);
      return null;
    }
  }

  return {
    getQueuePosition,
    getState,
    loadEpisode,
    restore,
    setAutoplayEnabled,
    setExpanded,
    setPlaybackError,
    setPlaybackStatus,
    setQueue,
    setTimeline,
    step,
    subscribe,
  };
}

function readAutoplayPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOPLAY_STORAGE_KEY));
    return saved?.schemaVersion === SCHEMA_VERSION && saved.enabled === true;
  } catch {
    return false;
  }
}

function persistAutoplayPreference(enabled) {
  try {
    localStorage.setItem(AUTOPLAY_STORAGE_KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      enabled,
    }));
  } catch (error) {
    console.warn("[MSSP] Could not persist autoplay preference.", error);
  }
}

function sortQueue(queue) {
  return [...queue].sort((a, b) => Number(a.globalIndex || 0) - Number(b.globalIndex || 0));
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
