import { PLAYBACK_STATUSES } from "./playerState.js";

const BUFFERING_GRACE_MS = 900;
const RECONCILABLE_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING,
  PLAYBACK_STATUSES.BUFFERING,
  PLAYBACK_STATUSES.PAUSED,
]);

export function createAudioController({ playerState, onEnded, onPauseIntent }) {
  const audio = new Audio();
  audio.preload = "metadata";
  audio.crossOrigin = "anonymous";

  let loadedEpisodeKey = null;
  let loadedSourceUrl = null;
  let playbackIntent = false;
  let loadToken = 0;
  let loadEvents = null;
  let bufferingTimer = null;

  document.addEventListener("visibilitychange", reconcilePlaybackState);
  window.addEventListener("pageshow", reconcilePlaybackState);
  window.addEventListener("focus", reconcilePlaybackState);

  function loadSelected({ playbackIntent: shouldPlay = false } = {}) {
    const state = playerState.getState();
    const episode = state.selectedEpisode;
    const source = state.source;

    if (!episode || !source?.url) {
      clearAudio();
      return Promise.resolve(false);
    }

    const sourceChanged = loadedEpisodeKey !== episode.episodeKey || loadedSourceUrl !== source.url;
    if (sourceChanged) loadSource(episode.episodeKey, source.url, shouldPlay);

    playbackIntent = Boolean(shouldPlay);
    return playbackIntent ? play() : Promise.resolve(true);
  }

  async function play() {
    const state = playerState.getState();
    if (!state.source?.url) return false;

    if (loadedEpisodeKey !== state.selectedEpisode?.episodeKey || loadedSourceUrl !== state.source.url) {
      return loadSelected({ playbackIntent: true });
    }

    playbackIntent = true;
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.LOADING);

    try {
      await audio.play();
      return true;
    } catch (error) {
      if (!isCurrentSource()) return false;
      playbackIntent = false;
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
    playbackIntent = false;
    clearBufferingTimer();
    const cancelledPendingAutoplay = onPauseIntent?.() === true;
    audio.pause();
    if (
      !cancelledPendingAutoplay
      && playerState.getState().source?.url
      && playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR
    ) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }
  }

  function toggle() {
    if (playerState.getState().playbackStatus === PLAYBACK_STATUSES.AUTOPLAY_PENDING) {
      pause();
      return Promise.resolve(true);
    }
    if (audio.paused) return play();
    pause();
    return Promise.resolve(true);
  }

  function seek(value) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(Number(value) || 0, audio.duration));
    updateTimeline();
  }

  function seekBy(offset) {
    seek(audio.currentTime + Number(offset || 0));
  }

  function loadSource(episodeKey, sourceUrl, shouldPlay) {
    invalidateLoad();
    resetAudioElement();

    loadedEpisodeKey = episodeKey;
    loadedSourceUrl = sourceUrl;
    playbackIntent = Boolean(shouldPlay);
    const token = loadToken;

    audio.src = sourceUrl;
    bindLoadEvents(token, audio.src);
    playerState.setTimeline({ currentTime: 0, duration: 0 });
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(playbackIntent ? PLAYBACK_STATUSES.LOADING : PLAYBACK_STATUSES.READY);
    audio.load();
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
      if (
        !playbackIntent
        && playerState.getState().playbackStatus === PLAYBACK_STATUSES.LOADING
      ) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.READY);
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
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
      }
    }), options);
    audio.addEventListener("pause", current(() => {
      playbackIntent = false;
      clearBufferingTimer();
      if (
        audio.paused
        && !audio.ended
        && [
          PLAYBACK_STATUSES.LOADING,
          PLAYBACK_STATUSES.BUFFERING,
          PLAYBACK_STATUSES.PLAYING,
        ].includes(playerState.getState().playbackStatus)
      ) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
      }
    }), options);
    audio.addEventListener("ended", current(() => {
      playbackIntent = false;
      clearBufferingTimer();
      updateTimeline();
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.ENDED);
      onEnded?.();
    }), options);
    audio.addEventListener("error", current(handleError), options);
  }

  function handleError() {
    playbackIntent = false;
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
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING);
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
    playbackIntent = false;
    playerState.setTimeline({ currentTime: 0, duration: 0 });
  }

  function invalidateLoad() {
    clearBufferingTimer();
    loadToken += 1;
    loadEvents?.abort();
    loadEvents = null;
  }

  function resetAudioElement() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
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
    };
  }

  function reconcilePlaybackState() {
    const snapshot = getAudioSnapshot();
    const status = playerState.getState().playbackStatus;
    if (
      snapshot.isCurrentSource
      && !snapshot.paused
      && !snapshot.ended
      && Number.isFinite(snapshot.currentTime)
      && RECONCILABLE_STATUSES.has(status)
    ) {
      playbackIntent = true;
      clearBufferingTimer();
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
    }
  }

  function clearBufferingTimer() {
    window.clearTimeout(bufferingTimer);
    bufferingTimer = null;
  }

  return {
    getAudioSnapshot,
    loadSelected,
    pause,
    play,
    reconcilePlaybackState,
    seek,
    seekBy,
    toggle,
  };
}
