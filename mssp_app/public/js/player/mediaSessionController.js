import { PLAYBACK_STATUSES } from "./playerState.js";

const DEFAULT_SEEK_SECONDS = 15;
const DEFAULT_FORWARD_SECONDS = 30;

export function createMediaSessionController({ playerState, audioController }) {
  if (!("mediaSession" in navigator)) return null;
  let metadataKey = null;
  let lastPlaybackState = "none";

  registerAction("play", () => audioController.play());
  registerAction("pause", () => audioController.pause());
  registerAction("seekbackward", (event) => audioController.seekBy(-(event.seekOffset || DEFAULT_SEEK_SECONDS)));
  registerAction("seekforward", (event) => audioController.seekBy(event.seekOffset || DEFAULT_FORWARD_SECONDS));
  registerAction("seekto", (event) => {
    if (Number.isFinite(event.seekTime)) audioController.seek(event.seekTime);
  });
  clearAction("previoustrack");
  clearAction("nexttrack");

  // iOS Now Playing can latch the first paused glyph; re-assert playing when the
  // screen turns off so the lock-screen control matches real audio.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    const state = playerState.getState();
    if (!state.selectedEpisode || !state.source?.url) return;
    if (resolveMediaPlaybackState(state) !== "playing") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: getMediaTitle(state.selectedEpisode),
        artist: state.selectedEpisode.type || "",
        album: getAlbum(state.selectedEpisode),
        artwork: getArtwork(state.selectedEpisode),
      });
    } catch {
      // Metadata refresh is best-effort.
    }
    applyPlaybackState("playing");
  });

  return playerState.subscribe(syncMediaSession);

  function syncMediaSession(state) {
    if (!state.selectedEpisode || !state.source?.url) {
      clearMediaSession();
      return;
    }

    const nextMetadataKey = [
      state.selectedEpisode.episodeKey,
      state.selectedEpisode.coverKind || state.selectedEpisode.collectionKind || "anthology",
    ].join("|");
    const nextPlaybackState = resolveMediaPlaybackState(state);
    const metadataChanged = metadataKey !== nextMetadataKey;
    // Re-bind metadata when entering playing so iOS doesn't keep a pre-play "paused" glyph.
    const enteringPlaying = nextPlaybackState === "playing" && lastPlaybackState !== "playing";

    if (metadataChanged || enteringPlaying) {
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

    applyPlaybackState(nextPlaybackState);

    if (Number.isFinite(state.duration) && state.duration > 0 && Number.isFinite(state.currentTime)) {
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
  }

  function applyPlaybackState(nextPlaybackState) {
    try {
      navigator.mediaSession.playbackState = nextPlaybackState;
      lastPlaybackState = nextPlaybackState;
    } catch {
      // Playback state support varies across browsers.
    }
  }

  function clearMediaSession() {
    metadataKey = null;
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

function resolveMediaPlaybackState(state) {
  const status = state.playbackStatus;
  const requested = state.playbackRequested;

  // Treat play-intent through load/buffer (including brief ready) as playing so
  // iOS never latches a pre-play "paused" control on first session paint.
  if (
    status === PLAYBACK_STATUSES.PLAYING
    || (requested && [
      PLAYBACK_STATUSES.READY,
      PLAYBACK_STATUSES.LOADING_SOURCE,
      PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
    ].includes(status))
  ) {
    return "playing";
  }

  if (status === PLAYBACK_STATUSES.PAUSED || status === PLAYBACK_STATUSES.ENDED) {
    return "paused";
  }

  // idle / ready / error / unavailable without an active pause — don't teach iOS "paused"
  return "none";
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
