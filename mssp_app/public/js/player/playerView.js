import { SOURCE_STATUSES } from "./sourceStatus.js";

const LOCK_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M7 9V7a5 5 0 0 1 10 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v2Zm3 4a2 2 0 0 1 1.18 3.62L14 20h-4l.82-3.38A2 2 0 0 1 12 13Z"></path>
  </svg>
`;

const PLAY_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m7 4 12 8-12 8V4Z"></path>
  </svg>
`;

const PAUSE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M7 5h3v14H7V5Z"></path>
    <path d="M14 5h3v14h-3V5Z"></path>
  </svg>
`;

export function createPlayerView({ dom, playerState, audioController, onStep, onAutoplayChange }) {
  let restoreFocusTo = null;
  let wasExpanded = false;

  function render(state) {
    const episode = state.selectedEpisode;
    const hasEpisode = Boolean(episode);
    dom.miniPlayer.hidden = !hasEpisode;
    document.body.classList.toggle("has-player", hasEpisode);

    if (!hasEpisode) {
      setExpandedUi(false);
      return;
    }

    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const accessLabel = episode.paytch === "PAYTCH" ? "PAYTCH" : "Public";
    const source = state.sourceStatus;
    const queuePosition = playerState.getQueuePosition();

    dom.miniPlayerCover.src = episode.coverUrl;
    dom.miniPlayerCover.alt = "";
    dom.miniPlayerTitle.textContent = `${episodeLabel} - ${episode.title || "Untitled episode"}`;
    dom.miniPlayerStatus.textContent = getPlaybackLabel(state);
    dom.miniPlayer.style.setProperty("--mini-player-progress", `${getProgressPercent(state)}%`);

    dom.fullPlayerCover.src = episode.coverUrl;
    dom.fullPlayerCover.alt = `${episode.title || "Selected episode"} cover`;
    dom.fullPlayerEyebrow.textContent = `${episode.type || "MSSP"} ${accessLabel} ${episodeLabel}`;
    dom.fullPlayerTitle.textContent = episode.title || "Untitled episode";
    dom.fullPlayerMeta.textContent = `${episode.date || "Unknown date"} · ${accessLabel}`;
    const playbackLabel = getPlaybackLabel(state);
    dom.fullPlayerStatus.textContent = playbackLabel;
    dom.fullPlayerStatusDetail.textContent = state.playbackError && state.playbackError !== playbackLabel
      ? state.playbackError
      : source.detail;
    dom.playerPrevious.disabled = !queuePosition.hasPrevious;
    dom.playerNext.disabled = !queuePosition.hasNext;
    dom.miniPlayerPrevious.disabled = !queuePosition.hasPrevious;
    dom.miniPlayerNext.disabled = !queuePosition.hasNext;
    dom.miniPlayerPlay.disabled = !isPlayable(state);
    dom.playerPlay.disabled = !isPlayable(state);
    dom.playerTimeline.disabled = !isPlayable(state) || !state.duration;
    dom.playerTimeline.max = String(Math.max(0, state.duration || 0));
    dom.playerTimeline.value = String(Math.min(state.currentTime || 0, state.duration || 0));
    dom.playerTimelineStart.textContent = formatTime(state.currentTime);
    dom.playerTimelineEnd.textContent = formatTime(state.duration);
    dom.playerTimeline.setAttribute(
      "aria-label",
      isPlayable(state) ? "Playback position" : "Playback position unavailable"
    );
    dom.playerAutoplay.checked = state.autoplayEnabled;
    renderPlaybackControl(dom.miniPlayerPlay, source, state.playbackStatus);
    renderPlaybackControl(dom.playerPlay, source, state.playbackStatus);
    setExpandedUi(state.isExpanded);
    if (state.isExpanded && !wasExpanded) {
      requestAnimationFrame(() => dom.fullPlayerCollapse.focus());
    }
    wasExpanded = state.isExpanded;
  }

  function expand(trigger = document.activeElement) {
    if (!playerState.getState().selectedEpisode) return;
    restoreFocusTo = trigger;
    playerState.setExpanded(true);
  }

  function renderPlaybackControl(button, source, playbackStatus) {
    const isLocked = source.id === SOURCE_STATUSES.RSS_REQUIRED;
    const isPlaying = playbackStatus === "playing" || playbackStatus === "autoplay_pending";
    button.innerHTML = isLocked ? LOCK_ICON : isPlaying ? PAUSE_ICON : PLAY_ICON;
    button.classList.toggle("is-locked", isLocked);
    button.setAttribute(
      "aria-label",
      isLocked ? "Connect Patreon RSS to play" : isPlaying ? "Pause episode" : "Play episode"
    );
  }

  function collapse() {
    if (!playerState.getState().isExpanded) return;
    playerState.setExpanded(false);
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected ? restoreFocusTo : dom.miniPlayerExpand;
      target.focus();
      restoreFocusTo = null;
    });
  }

  function setExpandedUi(isExpanded) {
    dom.fullPlayer.hidden = !isExpanded;
    dom.playerBackdrop.hidden = !isExpanded;
    dom.fullPlayer.setAttribute("aria-hidden", String(!isExpanded));
    document.body.classList.toggle("player-expanded", isExpanded);
    dom.app.inert = isExpanded;
    dom.miniPlayer.inert = isExpanded;
    if (!isExpanded) wasExpanded = false;
  }

  function trapFocus(event) {
    if (event.key === "Escape") {
      collapse();
      return;
    }
    if (event.key !== "Tab" || !playerState.getState().isExpanded) return;

    const focusable = [...dom.fullPlayer.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dom.miniPlayerExpand.addEventListener("click", (event) => expand(event.currentTarget));
  dom.fullPlayerCollapse.addEventListener("click", collapse);
  dom.playerBackdrop.addEventListener("click", collapse);
  dom.playerPrevious.addEventListener("click", () => onStep(-1));
  dom.playerNext.addEventListener("click", () => onStep(1));
  dom.miniPlayerPrevious.addEventListener("click", () => onStep(-1));
  dom.miniPlayerNext.addEventListener("click", () => onStep(1));
  dom.playerPlay.addEventListener("click", () => audioController.toggle());
  dom.miniPlayerPlay.addEventListener("click", () => audioController.toggle());
  dom.playerTimeline.addEventListener("input", (event) => audioController.seek(event.currentTarget.value));
  dom.playerAutoplay.addEventListener("change", (event) => {
    onAutoplayChange(event.currentTarget.checked);
  });
  document.addEventListener("keydown", trapFocus);
  playerState.subscribe(render);

  return {
    collapse,
    expand,
  };
}

function isPlayable(state) {
  return Boolean(state.source?.url) && state.sourceStatus?.id === SOURCE_STATUSES.READY;
}

function getPlaybackLabel(state) {
  if (state.playbackStatus === "loading") return "Loading audio...";
  if (state.playbackStatus === "buffering") return "Buffering...";
  if (state.playbackStatus === "playing") return "Playing";
  if (state.playbackStatus === "paused") return "Paused";
  if (state.playbackStatus === "ended") return "Episode finished";
  if (state.playbackStatus === "autoplay_pending") {
    return `Next episode starting in ${state.autoplayCountdown || 1}...`;
  }
  if (state.playbackStatus === "error") return "Unable to play audio. Tap Play to retry.";
  return state.sourceStatus.label;
}

function getProgressPercent(state) {
  if (!state.duration) return 0;
  return Math.max(0, Math.min(100, (state.currentTime / state.duration) * 100));
}

function formatTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
