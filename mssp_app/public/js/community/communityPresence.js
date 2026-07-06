import { PLAYBACK_STATUSES } from "../player/playerState.js";

const ACTIVE_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
  PLAYBACK_STATUSES.PLAYING,
]);

export function createCommunityPresence({
  playerState,
  communitySignals,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  heartbeatIntervalMs = 20_000,
} = {}) {
  let started = false;
  let unsubscribe = null;
  let desiredEpisodeKey = null;
  let activeEpisodeKey = null;
  let heartbeatTimer = null;
  let transition = Promise.resolve();

  const setIntervalFn = windowRef?.setInterval?.bind(windowRef) || globalThis.setInterval;
  const clearIntervalFn = windowRef?.clearInterval?.bind(windowRef) || globalThis.clearInterval;

  function start() {
    if (started) return;
    started = true;
    unsubscribe = playerState.subscribe(handlePlayerState);
    documentRef?.addEventListener?.("visibilitychange", handleVisibilityChange);
    windowRef?.addEventListener?.("online", handleOnline);
    windowRef?.addEventListener?.("beforeunload", handleBeforeUnload);
  }

  function stop() {
    if (!started) return;
    started = false;
    unsubscribe?.();
    unsubscribe = null;
    documentRef?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    windowRef?.removeEventListener?.("online", handleOnline);
    windowRef?.removeEventListener?.("beforeunload", handleBeforeUnload);
    clearHeartbeatTimer();
    if (activeEpisodeKey) {
      void communitySignals.sendPresenceHeartbeat({
        episodeKey: activeEpisodeKey,
        playing: false,
        keepalive: true,
      });
      activeEpisodeKey = null;
    }
    desiredEpisodeKey = null;
  }

  function handlePlayerState(state) {
    desiredEpisodeKey = getListeningEpisodeKey(state, documentRef?.visibilityState || "visible");
    queueReconcile();
  }

  function handleVisibilityChange() {
    handlePlayerState(playerState.getState());
  }

  function handleOnline() {
    if (activeEpisodeKey) {
      void communitySignals.sendPresenceHeartbeat({ episodeKey: activeEpisodeKey, playing: true });
    }
  }

  function handleBeforeUnload() {
    if (!activeEpisodeKey) return;
    void communitySignals.sendPresenceHeartbeat({
      episodeKey: activeEpisodeKey,
      playing: false,
      keepalive: true,
    });
  }

  function queueReconcile() {
    transition = transition.then(reconcile).catch(() => {});
  }

  async function reconcile() {
    if (!started || desiredEpisodeKey === activeEpisodeKey) return;
    clearHeartbeatTimer();
    const previousEpisodeKey = activeEpisodeKey;
    activeEpisodeKey = null;
    if (previousEpisodeKey) {
      await communitySignals.sendPresenceHeartbeat({
        episodeKey: previousEpisodeKey,
        playing: false,
      });
    }
    if (!started || !desiredEpisodeKey) return;
    activeEpisodeKey = desiredEpisodeKey;
    await communitySignals.sendPresenceHeartbeat({
      episodeKey: activeEpisodeKey,
      playing: true,
    });
    if (!started || !activeEpisodeKey) return;
    heartbeatTimer = setIntervalFn(() => {
      if (!activeEpisodeKey) return;
      void communitySignals.sendPresenceHeartbeat({
        episodeKey: activeEpisodeKey,
        playing: true,
      });
    }, heartbeatIntervalMs);
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  return { start, stop };
}

export function getListeningEpisodeKey(state, visibilityState = "visible") {
  if (!state?.selectedEpisode?.episodeKey || !state.playbackRequested) return null;
  if (!ACTIVE_STATUSES.has(state.playbackStatus)) return null;
  if (visibilityState !== "visible" && state.playbackStatus !== PLAYBACK_STATUSES.PLAYING) return null;
  return state.selectedEpisode.episodeKey;
}
