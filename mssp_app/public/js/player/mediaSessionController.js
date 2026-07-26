import { PLAYBACK_STATUSES } from "./playerState.js";

const DEFAULT_SEEK_SECONDS = 15;
const DEFAULT_FORWARD_SECONDS = 30;

export function createMediaSessionController({ playerState, audioController }) {
  if (!("mediaSession" in navigator)) return null;

  let metadataKey = null;
  let lastPlaybackState = "none";
  let sessionActivated = false;

  registerAction("play", () => audioController.play());
  registerAction("pause", () => audioController.pause());
  registerAction("seekbackward", (event) => audioController.seekBy(-(event.seekOffset || DEFAULT_SEEK_SECONDS)));
  registerAction("seekforward", (event) => audioController.seekBy(event.seekOffset || DEFAULT_FORWARD_SECONDS));
  registerAction("seekto", (event) => {
    if (Number.isFinite(event.seekTime)) audioController.seek(event.seekTime);
  });
  clearAction("previoustrack");
  clearAction("nexttrack");

  // Drive play/pause glyph from the active <audio> element. iOS Now Playing often
  // ignores playerState-derived playbackState until a lock-screen gesture, and can
  // latch a paused glyph if metadata is published before audio is actually playing.
  const unsubscribeMediaElement = audioController.subscribeMediaElementEvents?.((type) => {
    const state = playerState.getState();
    if (!state.selectedEpisode || !state.source?.url) {
      clearMediaSession();
      return;
    }

    if (type === "playing") {
      activatePlayingSession(state);
      return;
    }

    if (type === "pause") {
      // Ignore transient pauses while play intent is still active (seek/buffer).
      if (state.playbackRequested) return;
      applyPlaybackState("paused");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    const state = playerState.getState();
    if (!state.selectedEpisode || !state.source?.url) return;
    const audio = audioController.getActiveAudioElement?.();
    if (!audio || audio.paused || audio.ended) return;
    if (!state.playbackRequested && state.playbackStatus !== PLAYBACK_STATUSES.PLAYING) return;
    activatePlayingSession(state);
  });

  const unsubscribeState = playerState.subscribe(syncMediaSession);

  return () => {
    unsubscribeMediaElement?.();
    unsubscribeState?.();
  };

  function syncMediaSession(state) {
    if (!state.selectedEpisode || !state.source?.url) {
      clearMediaSession();
      return;
    }

    const nextMetadataKey = [
      state.selectedEpisode.episodeKey,
      state.selectedEpisode.coverKind || state.selectedEpisode.collectionKind || "anthology",
    ].join("|");

    // Episode changed — wait for the next real `playing` event before publishing
    // again, or iOS re-latches a paused Control Center / lock-screen glyph.
    if (metadataKey && metadataKey !== nextMetadataKey) {
      sessionActivated = false;
      metadataKey = null;
      applyPlaybackState("none");
      return;
    }

    // Until audio has actually started once for this selection, do not publish
    // Media Session metadata — that first paint is what iOS latches as paused.
    if (!sessionActivated) return;

    const audio = audioController.getActiveAudioElement?.();
    if (audio && !audio.paused && !audio.ended) {
      applyPlaybackState("playing");
    } else if (
      state.playbackStatus === PLAYBACK_STATUSES.PAUSED
      || state.playbackStatus === PLAYBACK_STATUSES.ENDED
    ) {
      applyPlaybackState("paused");
    }

    syncPositionState(state);
  }

  function activatePlayingSession(state) {
    sessionActivated = true;
    const nextMetadataKey = [
      state.selectedEpisode.episodeKey,
      state.selectedEpisode.coverKind || state.selectedEpisode.collectionKind || "anthology",
    ].join("|");
    publishMetadata(state, nextMetadataKey);
    applyPlaybackState("playing");
    syncPositionState(state);
  }

  function publishMetadata(state, nextMetadataKey) {
    metadataKey = nextMetadataKey;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: getMediaTitle(state.selectedEpisode),
        artist: state.selectedEpisode.type || "",
        album: getAlbum(state.selectedEpisode),
        artwork: getArtwork(state.selectedEpisode),
      });
    } catch (error) {
      console.warn("[MSSP] Media Session metadata could not be updated.", error);
    }
  }

  function syncPositionState(state) {
    if (!Number.isFinite(state.duration) || state.duration <= 0 || !Number.isFinite(state.currentTime)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: audioController.getPlaybackRate?.() || 1,
        position: Math.max(0, Math.min(state.currentTime, state.duration)),
      });
    } catch {
      // Some browsers expose Media Session but reject position updates.
    }
  }

  function applyPlaybackState(nextPlaybackState) {
    if (lastPlaybackState === nextPlaybackState) return;
    try {
      navigator.mediaSession.playbackState = nextPlaybackState;
      lastPlaybackState = nextPlaybackState;
    } catch {
      // Playback state support varies across browsers.
    }
  }

  function clearMediaSession() {
    metadataKey = null;
    sessionActivated = false;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      lastPlaybackState = "none";
    } catch {
      // Media Session is best-effort.
    }
  }

  function registerAction(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Unsupported actions should not affect in-app playback.
    }
  }

  function clearAction(action) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      // Unsupported actions should not affect in-app playback.
    }
  }
}

function getMediaTitle(episode) {
  const title = episode.title || "Untitled episode";
  const code = String(episode.episode || "").trim();
  if (!code) return title;
  if (/^\d+(?:\.\d+)*$/.test(code)) return `Ep. ${code} - ${title}`;
  return `${code} - ${title}`;
}

function getAlbum(episode) {
  if (episode.collectionKind === "old") return "The Old Testament";
  if (episode.collectionKind === "new") return "The New Testament";
  if (episode.collectionKind === "paytch") return "The PAYTCH";
  return "The Holy Trinity";
}

function getArtwork(episode) {
  const base = document.baseURI || window.location.href;
  const coverKind = episode.coverKind || episode.collectionKind || "anthology";

  const coverByKind = {
    old: "./assets/covers/old.webp",
    new: "./assets/covers/new.webp",
    paytch: "./assets/covers/paytch.webp",
    anthology: "./assets/covers/anthology.webp",
  };

  const coverPath = coverByKind[coverKind] || coverByKind.anthology;

  return [
    { src: new URL(coverPath, base).href, sizes: "512x512", type: "image/webp" },
    { src: new URL(coverPath, base).href, sizes: "192x192", type: "image/webp" },
    { src: new URL("./android-chrome-512x512.png", base).href, sizes: "512x512", type: "image/png" },
  ];
}
