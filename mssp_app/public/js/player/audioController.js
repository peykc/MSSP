import { PLAYBACK_STATUSES } from "./playerState.js";

export function createAudioController({ playerState, onEnded }) {
  const audio = new Audio();
  audio.preload = "metadata";
  audio.crossOrigin = "anonymous";
  let loadedEpisodeKey = null;
  let playbackIntent = false;

  audio.addEventListener("loadstart", () => {
    if (playbackIntent) playerState.setPlaybackStatus(PLAYBACK_STATUSES.LOADING);
  });
  audio.addEventListener("loadedmetadata", () => {
    updateTimeline();
    if (!playbackIntent) playerState.setPlaybackStatus(PLAYBACK_STATUSES.READY);
  });
  audio.addEventListener("durationchange", updateTimeline);
  audio.addEventListener("timeupdate", updateTimeline);
  audio.addEventListener("waiting", markBuffering);
  audio.addEventListener("stalled", markBuffering);
  audio.addEventListener("play", () => playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING));
  audio.addEventListener("pause", () => {
    if (
      playerState.getState().playbackStatus !== PLAYBACK_STATUSES.UNAVAILABLE
      && playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR
      && !audio.ended
    ) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }
  });
  audio.addEventListener("ended", () => {
    playbackIntent = false;
    updateTimeline();
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    onEnded?.();
  });
  audio.addEventListener("error", () => {
    const hadPlaybackIntent = playbackIntent;
    playbackIntent = false;
    if (!hadPlaybackIntent) {
      playerState.setPlaybackStatus(
        playerState.getState().source?.url
          ? PLAYBACK_STATUSES.READY
          : PLAYBACK_STATUSES.UNAVAILABLE
      );
      return;
    }
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.ERROR);
    playerState.setPlaybackError("Unable to play audio. Tap Play to retry.");
  });

  function loadSelected({ playbackIntent: shouldPlay = false } = {}) {
    const state = playerState.getState();
    const episode = state.selectedEpisode;
    const source = state.source;
    playbackIntent = Boolean(shouldPlay);

    if (!episode || !source?.url) {
      clearAudio();
      return Promise.resolve(false);
    }

    if (loadedEpisodeKey !== episode.episodeKey) {
      resetAudio();
      loadedEpisodeKey = episode.episodeKey;
      audio.src = source.url;
      audio.load();
      playerState.setTimeline({ currentTime: 0, duration: 0 });
      playerState.setPlaybackError("");
      playerState.setPlaybackStatus(playbackIntent ? PLAYBACK_STATUSES.LOADING : PLAYBACK_STATUSES.READY);
    }

    return playbackIntent ? play() : Promise.resolve(true);
  }

  async function play() {
    const state = playerState.getState();
    if (!state.source?.url) return false;
    playbackIntent = true;
    playerState.setPlaybackError("");
    if (loadedEpisodeKey !== state.selectedEpisode?.episodeKey) {
      return loadSelected({ playbackIntent: true });
    }
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.LOADING);

    try {
      await audio.play();
      return true;
    } catch (error) {
      playbackIntent = false;
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
      playerState.setPlaybackError("Press Play to start audio.");
      console.warn("[MSSP] Audio playback did not start.", error);
      return false;
    }
  }

  function pause() {
    playbackIntent = false;
    audio.pause();
  }

  function toggle() {
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

  function clearAudio() {
    playbackIntent = false;
    resetAudio();
    loadedEpisodeKey = null;
    playerState.setTimeline({ currentTime: 0, duration: 0 });
  }

  function resetAudio() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  function markBuffering() {
    if (playbackIntent) playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING);
  }

  function updateTimeline() {
    playerState.setTimeline({
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    });
  }

  return {
    loadSelected,
    pause,
    play,
    seek,
    seekBy,
    toggle,
  };
}
