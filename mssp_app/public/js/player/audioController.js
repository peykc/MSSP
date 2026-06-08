import { PLAYBACK_STATUSES } from "./playerState.js";

export function createAudioController({ playerState }) {
  const audio = new Audio();
  audio.preload = "metadata";
  audio.crossOrigin = "anonymous";
  let loadedEpisodeKey = null;

  audio.addEventListener("loadedmetadata", updateTimeline);
  audio.addEventListener("durationchange", updateTimeline);
  audio.addEventListener("timeupdate", updateTimeline);
  audio.addEventListener("play", () => playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING));
  audio.addEventListener("pause", () => {
    if (playerState.getState().playbackStatus !== PLAYBACK_STATUSES.UNAVAILABLE) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }
  });
  audio.addEventListener("ended", () => {
    updateTimeline();
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
  });
  audio.addEventListener("error", () => {
    playerState.setPlaybackError("Audio could not be loaded from the public source.");
  });

  function loadSelected({ autoplay = false } = {}) {
    const state = playerState.getState();
    const episode = state.selectedEpisode;
    const source = state.source;

    if (!episode || !source?.url) {
      clearAudio();
      return Promise.resolve(false);
    }

    if (loadedEpisodeKey !== episode.episodeKey) {
      audio.pause();
      loadedEpisodeKey = episode.episodeKey;
      audio.src = source.url;
      audio.load();
      playerState.setTimeline({ currentTime: 0, duration: 0 });
      playerState.setPlaybackError("");
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.READY);
    }

    return autoplay ? play() : Promise.resolve(true);
  }

  async function play() {
    const state = playerState.getState();
    if (!state.source?.url) return false;
    if (loadedEpisodeKey !== state.selectedEpisode?.episodeKey) loadSelected();

    try {
      await audio.play();
      return true;
    } catch (error) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
      playerState.setPlaybackError("Press Play to start audio.");
      console.warn("[MSSP] Audio playback did not start.", error);
      return false;
    }
  }

  function pause() {
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

  function clearAudio() {
    audio.pause();
    loadedEpisodeKey = null;
    audio.removeAttribute("src");
    audio.load();
    playerState.setTimeline({ currentTime: 0, duration: 0 });
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
    toggle,
  };
}
