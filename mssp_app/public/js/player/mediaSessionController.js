import { PLAYBACK_STATUSES } from "./playerState.js";

const DEFAULT_SEEK_SECONDS = 15;
const DEFAULT_FORWARD_SECONDS = 30;

export function createMediaSessionController({ playerState, audioController }) {
  if (!("mediaSession" in navigator)) return null;
  let metadataKey = null;

  registerAction("play", () => audioController.play());
  registerAction("pause", () => audioController.pause());
  registerAction("seekbackward", (event) => audioController.seekBy(-(event.seekOffset || DEFAULT_SEEK_SECONDS)));
  registerAction("seekforward", (event) => audioController.seekBy(event.seekOffset || DEFAULT_FORWARD_SECONDS));
  registerAction("seekto", (event) => {
    if (Number.isFinite(event.seekTime)) audioController.seek(event.seekTime);
  });
  clearAction("previoustrack");
  clearAction("nexttrack");

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

    if (metadataKey !== nextMetadataKey) {
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

    try {
      navigator.mediaSession.playbackState = state.playbackStatus === PLAYBACK_STATUSES.PLAYING
        ? "playing"
        : "paused";
    } catch {
      // Playback state support varies across browsers.
    }

    if (Number.isFinite(state.duration) && state.duration > 0 && Number.isFinite(state.currentTime)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: state.duration,
          playbackRate: 1,
          position: Math.max(0, Math.min(state.currentTime, state.duration)),
        });
      } catch {
        // Some browsers expose Media Session but reject position updates.
      }
    }
  }

  function clearMediaSession() {
    metadataKey = null;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
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
    old: "./assets/covers/old.jpg",
    new: "./assets/covers/new.jpg",
    paytch: "./assets/covers/paytch.jpg",
    anthology: "./assets/covers/anthology.jpg",
  };

  const coverPath = coverByKind[coverKind] || coverByKind.anthology;

  return [
    { src: new URL(coverPath, base).href, sizes: "512x512", type: "image/jpeg" },
    { src: new URL(coverPath, base).href, sizes: "192x192", type: "image/jpeg" },
    { src: new URL("./android-chrome-512x512.png", base).href, sizes: "512x512", type: "image/png" },
  ];
}
