import { PLAYBACK_STATUSES } from "./playerState.js";

const BUFFERING_GRACE_MS = 900;
const SAVE_INTERVAL_MS = 5000;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;
const RECONCILABLE_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
  PLAYBACK_STATUSES.PAUSED,
]);

export function createAudioController({ playerState, playbackProgressStore, onEnded }) {
  const audio = new Audio();
  audio.preload = "metadata";

  let loadedEpisodeKey = null;
  let loadedSourceUrl = null;
  let playbackIntent = false;
  let loadToken = 0;
  let loadEvents = null;
  let bufferingTimer = null;
  let playbackCommandToken = 0;
  let pendingPlayToken = null;
  let restoredLoadToken = null;

  function onVisibilityChange() {
    reconcilePlaybackState();
    if (document.visibilityState === "hidden") {
      savePlaybackPositionNow();
    }
  }

  function onPageHidden() {
    savePlaybackPositionNow();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", reconcilePlaybackState);
  window.addEventListener("focus", reconcilePlaybackState);
  window.addEventListener("pagehide", onPageHidden);
  window.addEventListener("beforeunload", onPageHidden);

  const saveInterval = window.setInterval(() => {
    if (!audio.paused && !audio.ended) {
      savePlaybackPositionNow();
    }
  }, SAVE_INTERVAL_MS);

  function loadSelected({ playbackIntent: shouldPlay = false } = {}) {
    const state = playerState.getState();
    const episode = state.selectedEpisode;
    const source = state.source;

    if (!episode || !source?.url) {
      clearAudio();
      return Promise.resolve(false);
    }

    const sourceChanged = loadedEpisodeKey !== episode.episodeKey || loadedSourceUrl !== source.url;
    if (sourceChanged) {
      const token = loadSource(episode.episodeKey, source, shouldPlay);
      setPlaybackIntent(shouldPlay);
      return shouldPlay ? beginPlaybackWhenReady(token) : Promise.resolve(true);
    }

    setPlaybackIntent(shouldPlay);
    return playbackIntent ? play() : Promise.resolve(true);
  }

  async function beginPlaybackWhenReady(token) {
    const ready = await waitUntilCanPlay(token);
    if (!ready || token !== loadToken || !playbackIntent || !isCurrentSource()) return false;
    return play();
  }

  function waitUntilCanPlay(token) {
    if (token !== loadToken || !isCurrentSource()) return Promise.resolve(false);
    if (audio.error) return Promise.resolve(false);
    if (audio.readyState >= HAVE_FUTURE_DATA) return Promise.resolve(true);

    return new Promise((resolve) => {
      const finish = (ready) => {
        cleanup();
        resolve(ready);
      };

      const onCanPlay = () => {
        if (token !== loadToken || !isCurrentSource()) {
          finish(false);
          return;
        }
        finish(!audio.error);
      };

      const onError = () => finish(false);
      const onAbort = () => finish(false);

      const cleanup = () => {
        audio.removeEventListener("canplay", onCanPlay);
        audio.removeEventListener("error", onError);
        loadEvents?.signal.removeEventListener("abort", onAbort);
      };

      audio.addEventListener("canplay", onCanPlay);
      audio.addEventListener("error", onError);
      loadEvents?.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function isStartingPlayback(status = playerState.getState().playbackStatus) {
    return playbackIntent && (
      pendingPlayToken !== null
      || status === PLAYBACK_STATUSES.LOADING_SOURCE
      || status === PLAYBACK_STATUSES.BUFFERING_PLAYBACK
    );
  }

  async function play() {
    const state = playerState.getState();
    if (!state.source?.url) return false;

    if (loadedEpisodeKey !== state.selectedEpisode?.episodeKey || loadedSourceUrl !== state.source.url) {
      return loadSelected({ playbackIntent: true });
    }

    const commandToken = ++playbackCommandToken;
    pendingPlayToken = commandToken;
    setPlaybackIntent(true);
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(
      Number.isFinite(audio.duration) && audio.duration > 0
        ? PLAYBACK_STATUSES.BUFFERING_PLAYBACK
        : PLAYBACK_STATUSES.LOADING_SOURCE
    );

    if (audio.readyState < HAVE_FUTURE_DATA && !audio.error) {
      const ready = await waitUntilCanPlay(loadToken);
      if (!ready || commandToken !== playbackCommandToken || !playbackIntent || !isCurrentSource()) {
        if (pendingPlayToken === commandToken) pendingPlayToken = null;
        return false;
      }
    }

    try {
      await audio.play();
      if (pendingPlayToken === commandToken) pendingPlayToken = null;
      if (commandToken !== playbackCommandToken) {
        if (!playbackIntent) audio.pause();
        return false;
      }
      if (!playbackIntent) {
        audio.pause();
        return false;
      }
      return true;
    } catch (error) {
      if (
        commandToken !== playbackCommandToken
        || !playbackIntent
        || !isCurrentSource()
      ) {
        return false;
      }
      if (pendingPlayToken === commandToken) pendingPlayToken = null;

      if (
        !audio.error
        && playbackIntent
        && isCurrentSource()
        && commandToken === playbackCommandToken
        && audio.readyState < HAVE_ENOUGH_DATA
      ) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
        void waitUntilCanPlay(loadToken).then((ready) => {
          if (ready && playbackIntent && commandToken === playbackCommandToken) {
            void play();
          }
        });
        return false;
      }

      setPlaybackIntent(false);
      clearBufferingTimer();
      if (playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
        playerState.setPlaybackError("Press Play to start audio.");
      }
      console.warn("[MSSP] Audio playback did not start.", error);
      return false;
    }
  }

  function pause() {
    playbackCommandToken += 1;
    pendingPlayToken = null;
    setPlaybackIntent(false);
    clearBufferingTimer();
    audio.pause();
    if (
      playerState.getState().source?.url
      && playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR
    ) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }
    savePlaybackPositionNow();
  }

  function toggle() {
    if (playerState.getState().playbackRequested) {
      pause();
      return Promise.resolve(true);
    }
    return play();
  }

  function seek(value, { persist = true } = {}) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return null;
    audio.currentTime = Math.max(0, Math.min(Number(value) || 0, audio.duration));
    updateTimeline();
    if (persist) savePlaybackPositionNow();
    return audio.currentTime;
  }

  function seekBy(offset) {
    return seek(audio.currentTime + Number(offset || 0));
  }

  function seekToRestoredPosition(time) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(Number(time) || 0, audio.duration));
    updateTimeline();
  }

  function restoreSavedPosition() {
    if (!playbackProgressStore || !loadedEpisodeKey) return;
    const savedTime = playbackProgressStore.getRestorablePosition(loadedEpisodeKey, audio.duration);
    if (savedTime !== null) seekToRestoredPosition(savedTime);
  }

  function savePlaybackPositionNow({ episodeKey } = {}) {
    if (!playbackProgressStore) return;

    const key = episodeKey || playerState.getState().selectedEpisode?.episodeKey;
    if (!key) return;
    if (!episodeKey && !isCurrentSource()) return;
    if (audio.ended) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    if (!Number.isFinite(audio.currentTime)) return;

    playbackProgressStore.savePosition({
      episodeKey: key,
      currentTime: audio.currentTime,
      duration: audio.duration,
    });
  }

  function loadSource(episodeKey, source, shouldPlay) {
    if (loadedEpisodeKey) {
      savePlaybackPositionNow({ episodeKey: loadedEpisodeKey });
    }

    invalidateLoad();
    resetAudioElement();
    configureCrossOrigin(source);
    audio.preload = shouldPlay ? "auto" : "metadata";

    loadedEpisodeKey = episodeKey;
    loadedSourceUrl = source.url;
    setPlaybackIntent(shouldPlay);
    const token = loadToken;

    audio.src = source.url;
    bindLoadEvents(token, audio.src);
    playerState.setTimeline({ currentTime: 0, duration: 0 });
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.LOADING_SOURCE);
    audio.load();
    return token;
  }

  function bindLoadEvents(token, expectedMediaUrl) {
    loadEvents = new AbortController();
    const options = { signal: loadEvents.signal };
    const current = (callback) => () => {
      if (
        token === loadToken
        && audio.currentSrc === expectedMediaUrl
        && isCurrentSource()
      ) {
        callback();
      }
    };

    audio.addEventListener("loadedmetadata", current(() => {
      updateTimeline();
      if (restoredLoadToken !== token) {
        restoredLoadToken = token;
        restoreSavedPosition();
      }
      if (playerState.getState().playbackStatus === PLAYBACK_STATUSES.LOADING_SOURCE) {
        playerState.setPlaybackStatus(
          playbackIntent ? PLAYBACK_STATUSES.BUFFERING_PLAYBACK : PLAYBACK_STATUSES.READY
        );
      }
    }), options);
    audio.addEventListener("durationchange", current(updateTimeline), options);
    audio.addEventListener("timeupdate", current(() => {
      clearBufferingTimer();
      updateTimeline();
      reconcilePlaybackState("timeupdate");
    }), options);
    audio.addEventListener("waiting", current(markBuffering), options);
    audio.addEventListener("stalled", current(markBuffering), options);
    audio.addEventListener("playing", current(() => {
      clearBufferingTimer();
      if (!audio.paused && !audio.ended) {
        if (playbackIntent) {
          playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
        } else {
          audio.pause();
        }
      }
    }), options);
    audio.addEventListener("pause", current(() => {
      clearBufferingTimer();
      if (!audio.paused || audio.ended) return;

      const status = playerState.getState().playbackStatus;
      if (![
        PLAYBACK_STATUSES.LOADING_SOURCE,
        PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
        PLAYBACK_STATUSES.PLAYING,
      ].includes(status)) {
        return;
      }

      if (isStartingPlayback(status) && audio.readyState < HAVE_ENOUGH_DATA) {
        if (status !== PLAYBACK_STATUSES.BUFFERING_PLAYBACK) {
          playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
        }
        return;
      }

      if (playbackIntent && pendingPlayToken === null) setPlaybackIntent(false);
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }), options);
    audio.addEventListener("ended", current(() => {
      setPlaybackIntent(false);
      clearBufferingTimer();
      if (loadedEpisodeKey) {
        playbackProgressStore?.markCompleted(loadedEpisodeKey);
      }
      updateTimeline();
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.ENDED);
      onEnded?.();
    }), options);
    audio.addEventListener("error", current(handleError), options);
  }

  function handleError() {
    pendingPlayToken = null;
    setPlaybackIntent(false);
    clearBufferingTimer();
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.ERROR);
    playerState.setPlaybackError("Unable to play audio. Tap Play to retry.");
  }

  function markBuffering() {
    clearBufferingTimer();
    const stalledAtTime = audio.currentTime;
    bufferingTimer = window.setTimeout(() => {
      bufferingTimer = null;
      const snapshot = getAudioSnapshot();
      if (
        playbackIntent
        && snapshot.isCurrentSource
        && !snapshot.paused
        && !snapshot.ended
        && Number.isFinite(snapshot.currentTime)
        && Math.abs(snapshot.currentTime - stalledAtTime) < 0.01
      ) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
      }
    }, BUFFERING_GRACE_MS);
  }

  function updateTimeline() {
    playerState.setTimeline({
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    });
  }

  function clearAudio() {
    invalidateLoad();
    resetAudioElement();
    loadedEpisodeKey = null;
    loadedSourceUrl = null;
    setPlaybackIntent(false);
    playerState.setTimeline({ currentTime: 0, duration: 0 });
  }

  function invalidateLoad() {
    clearBufferingTimer();
    playbackCommandToken += 1;
    pendingPlayToken = null;
    loadToken += 1;
    loadEvents?.abort();
    loadEvents = null;
  }

  function resetAudioElement() {
    audio.pause();
    audio.removeAttribute("src");
    audio.removeAttribute("crossorigin");
    audio.crossOrigin = null;
    audio.load();
  }

  function configureCrossOrigin(source) {
    if (source?.sourceType === "r2_audio") {
      audio.crossOrigin = "anonymous";
      return;
    }

    audio.removeAttribute("crossorigin");
    audio.crossOrigin = null;
  }

  function isCurrentSource() {
    const state = playerState.getState();
    return loadedEpisodeKey === state.selectedEpisode?.episodeKey && loadedSourceUrl === state.source?.url;
  }

  function getAudioSnapshot() {
    return {
      paused: audio.paused,
      ended: audio.ended,
      currentTime: audio.currentTime,
      readyState: audio.readyState,
      isCurrentSource: isCurrentSource(),
      playbackIntent,
    };
  }

  function getCurrentTime() {
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  }

  function reconcilePlaybackState() {
    const snapshot = getAudioSnapshot();
    const status = playerState.getState().playbackStatus;
    if (
      playbackIntent
      && snapshot.isCurrentSource
      && !snapshot.paused
      && !snapshot.ended
      && Number.isFinite(snapshot.currentTime)
      && RECONCILABLE_STATUSES.has(status)
    ) {
      clearBufferingTimer();
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
    }
  }

  function clearBufferingTimer() {
    window.clearTimeout(bufferingTimer);
    bufferingTimer = null;
  }

  function setPlaybackIntent(requested) {
    playbackIntent = Boolean(requested);
    playerState.setPlaybackRequested(playbackIntent);
  }

  function destroy() {
    window.clearInterval(saveInterval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", reconcilePlaybackState);
    window.removeEventListener("focus", reconcilePlaybackState);
    window.removeEventListener("pagehide", onPageHidden);
    window.removeEventListener("beforeunload", onPageHidden);
  }

  return {
    destroy,
    getAudioSnapshot,
    getCurrentTime,
    loadSelected,
    pause,
    play,
    reconcilePlaybackState,
    seek,
    seekBy,
    toggle,
  };
}
