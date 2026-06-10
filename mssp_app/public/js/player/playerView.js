import { PLAYBACK_STATUSES } from "./playerState.js";
import { SOURCE_STATUSES } from "./sourceStatus.js";

const SEEK_BACK_SECONDS = 15;
const SEEK_FORWARD_SECONDS = 30;
const SEEK_FEEDBACK_MS = 700;
const ACTIVE_PLAYBACK_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
  PLAYBACK_STATUSES.PLAYING,
]);
const TIMELINE_LOADING_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
]);

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

export function createPlayerView({ dom, playerState, audioController }) {
  let restoreFocusTo = null;
  let wasExpanded = false;
  let isScrubbing = false;
  let scrubPreviewTime = 0;
  let suppressNextChange = false;
  const tooltipTimers = new Map();

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
    const playable = isPlayable(state);
    const hasDuration = playable && Number.isFinite(state.duration) && state.duration > 0;

    dom.miniPlayerCover.src = episode.coverUrl;
    dom.miniPlayerCover.alt = "";
    dom.miniPlayerTitle.textContent = `${episodeLabel} - ${episode.title || "Untitled episode"}`;
    dom.miniPlayerStatus.textContent = getStableStatus(state);
    dom.miniPlayer.style.setProperty("--mini-player-progress", `${getProgressPercent(state)}%`);

    dom.fullPlayerCover.src = episode.coverUrl;
    dom.fullPlayerCover.alt = `${episode.title || "Selected episode"} cover`;
    dom.fullPlayerEyebrow.textContent = `${episode.type || "MSSP"} ${accessLabel} ${episodeLabel}`;
    dom.fullPlayerTitle.textContent = episode.title || "Untitled episode";
    dom.fullPlayerMeta.textContent = `${episode.date || "Unknown date"} · ${accessLabel}`;
    dom.fullPlayer.classList.toggle("is-playback-active", ACTIVE_PLAYBACK_STATUSES.has(state.playbackStatus));

    const showStatusPanel = !playable || Boolean(state.playbackError);
    dom.fullPlayerStatusPanel.hidden = !showStatusPanel;
    dom.fullPlayerStatus.textContent = state.playbackError ? "Unable to play audio." : source.label;
    dom.fullPlayerStatusDetail.textContent = state.playbackError ? "Tap Play to retry." : source.detail;

    dom.playerSeekBack.disabled = !hasDuration;
    dom.playerSeekForward.disabled = !hasDuration;
    dom.miniPlayerSeekBack.disabled = !hasDuration;
    dom.miniPlayerSeekForward.disabled = !hasDuration;
    dom.miniPlayerPlay.disabled = !playable;
    dom.playerPlay.disabled = !playable;
    renderTimeline(state);

    renderPlaybackControl(dom.miniPlayerPlay, source, state.playbackRequested);
    renderPlaybackControl(dom.playerPlay, source, state.playbackRequested);
    setExpandedUi(state.isExpanded);
    if (state.isExpanded && !wasExpanded) {
      requestAnimationFrame(() => dom.fullPlayerCollapse.focus());
    }
    wasExpanded = state.isExpanded;
  }

  function renderTimeline(state) {
    const playable = isPlayable(state);
    const loading = TIMELINE_LOADING_STATUSES.has(state.playbackStatus);
    const duration = Number.isFinite(state.duration) ? state.duration : 0;
    const shownTime = isScrubbing ? scrubPreviewTime : state.currentTime;

    dom.playerTimeline.disabled = !playable || !duration || loading;
    dom.playerTimeline.max = String(Math.max(0, duration));
    if (!isScrubbing) {
      dom.playerTimeline.value = String(Math.min(shownTime || 0, duration));
    }
    const progress = duration > 0 ? Math.max(0, Math.min(100, (shownTime / duration) * 100)) : 0;
    dom.playerTimeline.style.setProperty("--timeline-progress", `${progress}%`);
    dom.playerTimelineStart.classList.toggle("is-loading", loading);
    dom.playerTimelineStart.textContent = loading ? "" : formatTime(shownTime);
    dom.playerTimelineEnd.textContent = loading || !duration
      ? "--:--"
      : `-${formatTime(Math.max(0, duration - shownTime))}`;
    dom.playerTimeline.setAttribute(
      "aria-label",
      playable ? "Playback position" : "Playback position unavailable"
    );
  }

  function expand(trigger = document.activeElement) {
    if (!playerState.getState().selectedEpisode) return;
    restoreFocusTo = trigger;
    playerState.setExpanded(true);
  }

  function renderPlaybackControl(button, source, playbackRequested) {
    const isLocked = source.id === SOURCE_STATUSES.RSS_REQUIRED;
    const mode = isLocked ? "locked" : playbackRequested ? "pause" : "play";
    if (button.dataset.controlMode !== mode) {
      button.innerHTML = mode === "locked" ? LOCK_ICON : mode === "pause" ? PAUSE_ICON : PLAY_ICON;
      button.dataset.controlMode = mode;
    }
    button.classList.toggle("is-locked", isLocked);
    button.setAttribute(
      "aria-label",
      isLocked ? "Connect Patreon RSS to play" : playbackRequested ? "Pause episode" : "Play episode"
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

  function seekBy(offset, surface) {
    const seekTime = audioController.seekBy(offset);
    if (seekTime === null) return;
    showTimelineTooltip(surface, formatSeekOffset(offset), seekTime);
  }

  function showTimelineTooltip(surface, label, seekTime) {
    const element = surface === "mini" ? dom.miniPlayerTimelineTooltip : dom.playerTimelineTooltip;
    const duration = playerState.getState().duration;
    const percent = duration > 0 ? (seekTime / duration) * 100 : 0;
    window.clearTimeout(tooltipTimers.get(element));
    element.textContent = label;
    element.style.setProperty("--scrub-position", `${percent}%`);
    element.hidden = false;
    tooltipTimers.set(element, window.setTimeout(() => {
      element.hidden = true;
    }, SEEK_FEEDBACK_MS));
  }

  function beginScrub(event) {
    if (dom.playerTimeline.disabled) return;
    window.clearTimeout(tooltipTimers.get(dom.playerTimelineTooltip));
    isScrubbing = true;
    suppressNextChange = false;
    dom.playerTimeline.setPointerCapture?.(event.pointerId);
    updateScrubPreview(dom.playerTimeline.value);
  }

  function updateScrubPreview(value) {
    if (!isScrubbing) return;
    const duration = playerState.getState().duration;
    scrubPreviewTime = clampTime(value, duration);
    const percent = duration > 0 ? (scrubPreviewTime / duration) * 100 : 0;
    dom.playerTimelineTooltip.textContent = formatTime(scrubPreviewTime);
    dom.playerTimelineTooltip.style.setProperty("--scrub-position", `${percent}%`);
    dom.playerTimelineTooltip.hidden = false;
    renderTimeline(playerState.getState());
  }

  function commitScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    suppressNextChange = true;
    dom.playerTimelineTooltip.hidden = true;
    audioController.seek(scrubPreviewTime);
    window.setTimeout(() => {
      suppressNextChange = false;
    }, 0);
  }

  function cancelScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    dom.playerTimelineTooltip.hidden = true;
    renderTimeline(playerState.getState());
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
  dom.playerSeekBack.addEventListener("click", () => seekBy(-SEEK_BACK_SECONDS, "full"));
  dom.playerSeekForward.addEventListener("click", () => seekBy(SEEK_FORWARD_SECONDS, "full"));
  dom.miniPlayerSeekBack.addEventListener("click", () => seekBy(-SEEK_BACK_SECONDS, "mini"));
  dom.miniPlayerSeekForward.addEventListener("click", () => seekBy(SEEK_FORWARD_SECONDS, "mini"));
  dom.playerPlay.addEventListener("click", () => audioController.toggle());
  dom.miniPlayerPlay.addEventListener("click", () => audioController.toggle());
  dom.playerTimeline.addEventListener("pointerdown", beginScrub);
  dom.playerTimeline.addEventListener("pointerup", commitScrub);
  dom.playerTimeline.addEventListener("pointercancel", cancelScrub);
  dom.playerTimeline.addEventListener("input", (event) => {
    if (isScrubbing) updateScrubPreview(event.currentTarget.value);
    else audioController.seek(event.currentTarget.value);
  });
  dom.playerTimeline.addEventListener("change", (event) => {
    if (!isScrubbing && !suppressNextChange) audioController.seek(event.currentTarget.value);
  });
  dom.playerTimeline.addEventListener("blur", cancelScrub);
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

function getStableStatus(state) {
  if (state.playbackError) return state.playbackError;
  return state.sourceStatus.detail || state.sourceStatus.label;
}

function getProgressPercent(state) {
  if (!state.duration) return 0;
  return Math.max(0, Math.min(100, (state.currentTime / state.duration) * 100));
}

function clampTime(value, duration) {
  return Math.max(0, Math.min(Number(value) || 0, Number(duration) || 0));
}

function formatTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatSeekOffset(seconds) {
  const sign = seconds >= 0 ? "+" : "-";
  return `${sign}${formatTime(Math.abs(seconds))}`;
}
