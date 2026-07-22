import { PLAYBACK_STATUSES } from "./playerState.js";
import { SOURCE_STATUSES } from "./sourceStatus.js";
import { createCoverAmbient } from "./coverAmbient.js?v=ambient-stamp-c";
import { createTranscriptView } from "./transcriptView.js?v=scroll-hydrate-m";
import { createTranscriptSearch } from "./transcriptSearch.js?v=search-ops-a";
import { formatPlayerDate } from "../utils.js";
import { formatViewSignal, VIEW_EYE_ICON, VIEW_PENDING_MARK } from "../community/communitySignals.js?v=poll-cut-a";
import {
  createEpisodeRow,
  createEpisodeRowMenuManager,
  refreshEpisodeRow,
  updateEpisodeRowFavorite,
  updateEpisodeRowMarquee,
  updateEpisodeRowMenuItems,
  updateEpisodeRowProgress,
  updateEpisodeRowSignals,
} from "../episodeRow.js?v=poll-cut-a";

const SEEK_BACK_SECONDS = 15;
const SEEK_FORWARD_SECONDS = 30;
const SEEK_BURST_MS = 1200;
const PLAYBACK_RATES = Object.freeze([2, 1.75, 1.5, 1.25, 1, 0.75, 0.5]);
const DEFAULT_PLAYBACK_RATE = 1;
const ACTIVE_PLAYBACK_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
  PLAYBACK_STATUSES.PLAYING,
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

const DRAG_ACTIVATE_PX = 8;
const DRAG_VELOCITY_THRESHOLD = 0.45;
const DRAG_COMPLETE_FRACTION = 0.28;
const CLICK_SUPPRESS_MS = 350;
const QUEUE_WINDOW_LIMIT = 10;
const FULL_PLAYER_MODES = Object.freeze({
  PLAYER: "player",
  QUEUE: "queue",
  TRANSCRIPT: "transcript",
});

export function createPlayerView({
  dom,
  playerState,
  audioController,
  favoritesStore,
  communitySignals,
  onFavoriteToggle,
  playbackProgressStore,
  getSourceStatusForEpisode = () => ({ id: SOURCE_STATUSES.MISSING, label: "Source unavailable" }),
  onSelectRequest = () => {},
  onPlayRequest = () => {},
  onLockedRequest = () => {},
  onRegisterQueueRefresh = () => {},
}) {
  let restoreFocusTo = null;
  let wasExpanded = false;
  let fullPlayerMode = FULL_PLAYER_MODES.PLAYER;
  let isScrubbing = false;
  let scrubPreviewTime = 0;
  let suppressNextChange = false;
  let isDragging = false;
  let gesture = null;
  let dragTranslate = 0;
  let suppressClickUntil = 0;
  let scrubPointerId = null;
  let seekBurstTotal = 0;
  let seekBurstTimer = null;
  let activeSeekTooltipSurface = null;
  let lastBurstEpisodeKey = null;
  let lastBurstSourceKey = null;
  let lastBurstHadError = false;
  let lastBurstWasEnded = false;
  let queueSelectionTimer = null;
  let queueReindexAnimationActive = false;
  let queueRenderLocked = false;
  let compactQueueRow = null;
  let speedMenuListeners = null;
  let speedMenuIgnoreOutsideUntil = 0;
  let speedBarrelScrollTimer = null;
  let speedBarrelSyncing = false;
  let speedBarrelPointer = null;
  const coverAmbient = createCoverAmbient({ root: dom.fullPlayer });
  const queueMenuManager = createEpisodeRowMenuManager({ scrollRoot: dom.fullPlayerQueueList });
  const transcriptView = createTranscriptView({
    dom,
    audioController,
    getPlaybackTime: () => {
      const audioTime = audioController.getCurrentTime();
      if (audioTime > 0) return audioTime;
      const { currentTime, selectedEpisode } = playerState.getState();
      if (currentTime > 0) return currentTime;
      return playbackProgressStore.getSavedCurrentTime(selectedEpisode?.episodeKey) ?? 0;
    },
    onAvailabilityChange: handleTranscriptAvailabilityChange,
    onCenterRestoreComplete: () => {
      transcriptRestoreSynced = true;
    },
  });
  const transcriptSearch = createTranscriptSearch({
    dom,
    transcriptView,
    getIsPlayerOpen: () => playerState.getState().isExpanded,
  });
  transcriptView.setBeforeApplyTranscript(() => {
    transcriptSearch.resetForEpisode();
  });
  let transcriptRestoreSynced = false;
  let transcriptRestoreEpisodeKey = "";
  let transcriptRestoreSeenTime = 0;
  let lastFullRenderKey = "";
  let lastMarqueeTitle = "";
  let lastMarqueeWidth = 0;
  function isEpisodeCompleted(episode) {
    return playbackProgressStore?.getEpisodeProgress(episode.episodeKey)?.status === "completed";
  }

  function finishQueueMarkListened() {
    queueRenderLocked = false;
  }

  function advanceToNextPlayableEpisode(fromEpisode) {
    const nextEpisode = playerState.getNextPlayableEpisode(
      fromEpisode.episodeKey,
      (episode) => !isEpisodeCompleted(episode),
    );
    if (!nextEpisode) {
      finishQueueMarkListened();
      renderQueuePanel(playerState.getState());
      return;
    }

    animateQueueSelection(nextEpisode, async (episode, options) => {
      finishQueueMarkListened();
      await onPlayRequest(episode, options);
    });
  }

  function handleQueueMarkListened(episode, row) {
    queueMenuManager.closeEpisodeMenu();
    queueRenderLocked = true;
    playbackProgressStore?.markCompleted(episode.episodeKey);
    if (row) {
      updateEpisodeRowProgress(row, episode, playbackProgressStore);
      updateEpisodeRowMenuItems(row, episode, playbackProgressStore);
    }

    const state = playerState.getState();
    if (state.selectedEpisode?.episodeKey === episode.episodeKey) {
      advanceToNextPlayableEpisode(episode);
      return;
    }

    animateQueueItemRemoval(episode, () => {
      finishQueueMarkListened();
      renderQueuePanel(playerState.getState());
    });
  }

  const queueRowOptions = {
    includePlay: false,
    includeSignals: true,
    marqueeAlways: true,
    playbackProgressStore,
    favoritesStore,
    communitySignals,
    onFavoriteToggle,
    getSourceStatusForEpisode,
    menuManager: queueMenuManager,
    onMarkListened: handleQueueMarkListened,
  };
  const timelineScrubber = dom.playerTimeline.closest(".player-timeline__scrubber");
  const miniPlayerEpisode = dom.miniPlayerTitle.querySelector(".mini-player__episode");
  const miniPlayerTitleText = dom.miniPlayerTitle.querySelector(".mini-player__title-text");
  const fullPlayerEpisode = dom.fullPlayerTitle.querySelector(".full-player__episode");
  const fullPlayerTitleText = dom.fullPlayerTitle.querySelector(".full-player__title-text");
  const tooltipTimers = new Map();

  function getSourceKey(state) {
    return state.source?.url
      || state.source?.objectKey
      || state.sourceStatus?.id
      || "";
  }

  function getSeekTooltipElement(surface) {
    return surface === "mini" ? dom.miniPlayerTimelineTooltip : dom.playerTimelineTooltip;
  }

  function resetSeekBurst() {
    seekBurstTotal = 0;
    if (seekBurstTimer) {
      window.clearTimeout(seekBurstTimer);
      seekBurstTimer = null;
    }
  }

  function hideSeekTooltip(surface) {
    if (surface === "mini" || surface === "full") {
      const element = getSeekTooltipElement(surface);
      window.clearTimeout(tooltipTimers.get(element));
      tooltipTimers.delete(element);
      element.hidden = true;
      return;
    }
    hideSeekTooltip("mini");
    hideSeekTooltip("full");
  }

  function clearBurstContext() {
    resetSeekBurst();
    hideSeekTooltip();
    activeSeekTooltipSurface = null;
  }

  function extendSeekBurst(offset) {
    window.clearTimeout(seekBurstTimer);
    seekBurstTotal = seekBurstTimer ? seekBurstTotal + offset : offset;
    seekBurstTimer = window.setTimeout(() => {
      seekBurstTimer = null;
      seekBurstTotal = 0;
      activeSeekTooltipSurface = null;
      hideSeekTooltip();
    }, SEEK_BURST_MS);
    return seekBurstTotal;
  }

  function maybeResetBurstOnContextChange(state, episode) {
    const episodeKey = episode?.episodeKey || "";
    const sourceKey = getSourceKey(state);
    const hasError = Boolean(state.playbackError);
    const isEnded = state.playbackStatus === PLAYBACK_STATUSES.ENDED;
    let shouldReset = false;

    if (!episode) {
      shouldReset = true;
    } else if (lastBurstEpisodeKey !== null && episodeKey !== lastBurstEpisodeKey) {
      shouldReset = true;
    } else if (lastBurstSourceKey !== null && sourceKey !== lastBurstSourceKey) {
      shouldReset = true;
    } else if (!lastBurstWasEnded && isEnded) {
      shouldReset = true;
    } else if (!lastBurstHadError && hasError) {
      shouldReset = true;
    }

    if (shouldReset) {
      clearBurstContext();
    }

    if (episode) {
      lastBurstEpisodeKey = episodeKey;
      lastBurstSourceKey = sourceKey;
      lastBurstHadError = hasError;
      lastBurstWasEnded = isEnded;
    } else {
      lastBurstEpisodeKey = null;
      lastBurstSourceKey = null;
      lastBurstHadError = false;
      lastBurstWasEnded = false;
    }
  }

  function getFullRenderKey(state) {
    return [
      state.selectedEpisode?.episodeKey || "",
      state.collectionId || "",
      state.queueVersion,
      state.playbackStatus,
      state.playbackRequested ? "1" : "0",
      state.isExpanded ? "1" : "0",
      state.fullPlayerMode || "",
      state.playbackError || "",
      state.sourceStatus?.id || "",
      state.source?.url || "",
      Number.isFinite(state.duration) ? Math.round(state.duration) : 0,
    ].join("\0");
  }

  function renderTimelineOnly(state) {
    renderTimeline(state);
    dom.miniPlayer.style.setProperty("--mini-player-progress", `${getProgressPercent(state)}%`);
    transcriptView.setPlaybackActive(state.playbackStatus === PLAYBACK_STATUSES.PLAYING);
    if (
      fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT
      && state.isExpanded
      && !transcriptRestoreSynced
    ) {
      renderTranscriptMode(state);
    }
  }

  function render(state) {
    syncFullPlayerModeFromState(state);
    const episode = state.selectedEpisode;
    const hasEpisode = Boolean(episode);
    dom.miniPlayer.hidden = !hasEpisode;
    dom.fullPlayer.hidden = !hasEpisode;
    dom.playerBackdrop.hidden = !hasEpisode;
    document.body.classList.toggle("has-player", hasEpisode);

    if (!hasEpisode) {
      communitySignals?.setTrackedEpisodeKeys("player", []);
      communitySignals?.setTrackedEpisodeKeys("queue", []);
      void transcriptView.setSelectedEpisode(null);
      maybeResetBurstOnContextChange(state, null);
      setExpandedUi(false);
      lastFullRenderKey = "";
      lastMarqueeTitle = "";
      return;
    }

    const renderKey = getFullRenderKey(state);
    if (renderKey === lastFullRenderKey) {
      renderTimelineOnly(state);
      return;
    }
    lastFullRenderKey = renderKey;

    communitySignals?.setTrackedEpisodeKeys("player", [episode.episodeKey]);

    transcriptView.setSelectedEpisode(episode);

    maybeResetBurstOnContextChange(state, episode);

    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const accessLabel = episode.paytch === "PAYTCH" ? "PAYTCH" : "Public";
    const source = state.sourceStatus;
    const playable = isPlayable(state);

    if (playable && state.playbackStatus === PLAYBACK_STATUSES.READY && state.duration === 0) {
      void audioController.loadSelected({ playbackIntent: false });
    }

    void coverAmbient.setCover(episode.coverUrl);
    dom.miniPlayerCover.src = episode.coverUrl;
    dom.miniPlayerCover.alt = "";
    miniPlayerEpisode.textContent = episodeLabel;
    miniPlayerTitleText.textContent = episode.title || "Untitled episode";
    dom.miniPlayerStatus.textContent = state.playbackError
      ? state.playbackError
      : formatMiniPlayerSubtitle(episode);
    dom.miniPlayer.style.setProperty("--mini-player-progress", `${getProgressPercent(state)}%`);

    dom.fullPlayerCover.src = episode.coverUrl;
    dom.fullPlayerCover.alt = `${episode.title || "Selected episode"} cover`;
    dom.fullPlayerEyebrow.textContent = formatPlayerDate(episode.date);
    fullPlayerEpisode.textContent = episodeLabel;
    fullPlayerTitleText.textContent = episode.title || "Untitled episode";
    dom.fullPlayerMeta.textContent = `${episode.type || "MSSP"} · ${accessLabel}`;
    renderFavorite();
    renderCommunitySignals();
    dom.fullPlayer.classList.toggle("is-playback-active", ACTIVE_PLAYBACK_STATUSES.has(state.playbackStatus));

    const showStatusPanel = !playable || Boolean(state.playbackError);
    dom.fullPlayerStatusPanel.hidden = !showStatusPanel;
    dom.fullPlayerStatus.textContent = state.playbackError ? "Unable to play audio." : source.label;
    dom.fullPlayerStatusDetail.textContent = state.playbackError ? "Tap Play to retry." : source.detail;

    const isLocked = source.id === SOURCE_STATUSES.RSS_REQUIRED;
    dom.miniPlayerPlay.disabled = !playable && !isLocked;
    dom.playerPlay.disabled = !playable && !isLocked;
    renderTimeline(state);

    renderPlaybackControl(dom.miniPlayerPlay, source, state.playbackRequested);
    renderPlaybackControl(dom.playerPlay, source, state.playbackRequested);
    renderQueueMode(state);
    setExpandedUi(state.isExpanded);
    renderTranscriptMode(state);
    requestAnimationFrame(updateFullPlayerTitleMarquee);
    if (state.isExpanded && !wasExpanded) {
      requestAnimationFrame(() => dom.fullPlayerCollapse.focus());
    }
    wasExpanded = state.isExpanded;
  }

  function updateFullPlayerTitleMarquee() {
    const viewport = dom.fullPlayerTitle.querySelector(".full-player__title-viewport");
    if (!viewport || !fullPlayerTitleText) return;

    const title = fullPlayerTitleText.textContent || "";
    const width = viewport.clientWidth;
    if (title === lastMarqueeTitle && Math.abs(width - lastMarqueeWidth) <= 1) {
      if (fullPlayerTitleText.getAnimations().length) return;
    }
    lastMarqueeTitle = title;
    lastMarqueeWidth = width;

    fullPlayerTitleText.getAnimations().forEach((animation) => animation.cancel());
    fullPlayerTitleText.style.transform = "";
    fullPlayerTitleText.style.opacity = "";

    const distance = fullPlayerTitleText.scrollWidth - viewport.clientWidth;
    if (distance <= 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const holdMs = 1000;
    const fadeMs = 280;
    const resetMs = 120;
    const speedPxPerSecond = 42;
    const scrollMs = Math.max(4200, Math.min(18000, (distance / speedPxPerSecond) * 1000));
    const duration = holdMs + scrollMs + holdMs + fadeMs + resetMs + fadeMs;

    fullPlayerTitleText.animate(
      [
        { transform: "translateX(0)", opacity: 1, offset: 0 },
        { transform: "translateX(0)", opacity: 1, offset: holdMs / duration },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 1,
          offset: (holdMs + scrollMs) / duration,
        },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 1,
          offset: (holdMs + scrollMs + holdMs) / duration,
        },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 0,
          offset: (holdMs + scrollMs + holdMs + fadeMs) / duration,
        },
        {
          transform: "translateX(0)",
          opacity: 0,
          offset: (holdMs + scrollMs + holdMs + fadeMs + resetMs) / duration,
        },
        { transform: "translateX(0)", opacity: 1, offset: 1 },
      ],
      {
        duration,
        easing: "linear",
        iterations: Infinity,
      },
    );
  }

  function renderTimeline(state) {
    const seekable = canSeek(state);
    const metadataLoading = (
      state.playbackStatus === PLAYBACK_STATUSES.LOADING_SOURCE
      || state.playbackStatus === PLAYBACK_STATUSES.BUFFERING_PLAYBACK
    ) && !state.playbackError;
    const duration = Number.isFinite(state.duration) ? state.duration : 0;
    const shownTime = isScrubbing ? scrubPreviewTime : state.currentTime;

    dom.playerTimeline.disabled = !seekable;
    dom.playerTimeline.max = String(Math.max(0, duration));
    if (!isScrubbing) {
      dom.playerTimeline.value = String(Math.min(shownTime || 0, duration));
    }
    const progress = duration > 0 ? Math.max(0, Math.min(100, (shownTime / duration) * 100)) : 0;
    dom.playerTimeline.style.setProperty("--timeline-progress", `${progress}%`);
    dom.playerTimelineStart.classList.toggle("is-loading", metadataLoading);
    dom.playerTimelineStart.textContent = metadataLoading ? "" : formatTime(shownTime);
    dom.playerTimelineEnd.textContent = metadataLoading || !duration
      ? "--:--"
      : `-${formatTime(Math.max(0, duration - shownTime))}`;
    dom.playerTimeline.setAttribute(
      "aria-label",
      seekable ? "Playback position" : "Playback position unavailable"
    );
    syncPlaybackSpeedUi();
  }

  function formatPlaybackRateLabel(rate) {
    const normalized = Number(rate);
    if (!Number.isFinite(normalized)) return "1x";
    const rounded = Math.round(normalized * 100) / 100;
    return `${rounded}x`;
  }

  function normalizePlaybackRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_PLAYBACK_RATE;
    let closest = PLAYBACK_RATES[0];
    let closestDelta = Math.abs(value - closest);
    for (const option of PLAYBACK_RATES) {
      const delta = Math.abs(value - option);
      if (delta < closestDelta) {
        closest = option;
        closestDelta = delta;
      }
    }
    return closest;
  }

  function syncPlaybackSpeedUi(rate = audioController.getPlaybackRate?.()) {
    const selected = normalizePlaybackRate(rate);
    const label = formatPlaybackRateLabel(selected);
    dom.playerSpeedValue.textContent = label;
    dom.playerSpeedToggle.setAttribute("aria-label", `Playback speed ${label}`);
    for (const option of dom.playerSpeedBarrel.querySelectorAll(".full-player__speed-barrel-option")) {
      const optionRate = Number(option.dataset.rate);
      option.setAttribute("aria-selected", String(optionRate === selected));
    }
  }

  function getSpeedBarrelRowHeight() {
    const option = dom.playerSpeedBarrel.querySelector(".full-player__speed-barrel-option");
    const measured = option?.getBoundingClientRect().height || 0;
    if (measured > 0) return measured;
    const raw = getComputedStyle(dom.playerSpeedPanel).getPropertyValue("--speed-row").trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 22;
  }

  function getSpeedBarrelIndexFromScroll() {
    const row = getSpeedBarrelRowHeight();
    if (row <= 0) return 0;
    return Math.max(0, Math.min(PLAYBACK_RATES.length - 1, Math.round(dom.playerSpeedBarrel.scrollTop / row)));
  }

  function scrollSpeedBarrelToRate(rate, { smooth = false } = {}) {
    const selected = normalizePlaybackRate(rate);
    const index = PLAYBACK_RATES.indexOf(selected);
    if (index < 0) return;
    const row = getSpeedBarrelRowHeight();
    const top = index * row;
    window.clearTimeout(speedBarrelScrollTimer);
    speedBarrelSyncing = true;
    if (smooth && typeof dom.playerSpeedBarrel.scrollTo === "function") {
      setSpeedBarrelSnapEnabled(false);
      dom.playerSpeedBarrel.scrollTo({ top, behavior: "smooth" });
      speedBarrelScrollTimer = window.setTimeout(() => {
        speedBarrelSyncing = false;
        setSpeedBarrelSnapEnabled(true);
        if (Math.abs(dom.playerSpeedBarrel.scrollTop - top) > 1) {
          dom.playerSpeedBarrel.scrollTop = top;
        }
      }, 280);
      return;
    }
    dom.playerSpeedBarrel.scrollTop = top;
    window.requestAnimationFrame(() => {
      speedBarrelSyncing = false;
    });
  }

  function commitSpeedBarrelSelection(rate, { close = false } = {}) {
    const nextRate = normalizePlaybackRate(rate);
    audioController.setPlaybackRate?.(nextRate);
    syncPlaybackSpeedUi(nextRate);
    if (close) closePlaybackSpeedMenu();
  }

  function setSpeedBarrelSnapEnabled(enabled) {
    dom.playerSpeedBarrel.classList.toggle("is-dragging", !enabled);
  }

  function settleSpeedBarrelSelection({ smooth = true } = {}) {
    if (!speedMenuListeners) return;
    const index = getSpeedBarrelIndexFromScroll();
    const rate = PLAYBACK_RATES[index];
    if (rate == null) return;
    scrollSpeedBarrelToRate(rate, { smooth });
    commitSpeedBarrelSelection(rate);
  }

  function handleSpeedBarrelScroll() {
    if (speedBarrelSyncing || !speedMenuListeners || speedBarrelPointer) return;
    window.clearTimeout(speedBarrelScrollTimer);
    speedBarrelScrollTimer = window.setTimeout(() => {
      if (!speedMenuListeners || speedBarrelPointer) return;
      settleSpeedBarrelSelection();
    }, 140);
  }

  function onSpeedBarrelPointerDown(event) {
    if (!speedMenuListeners) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    window.clearTimeout(speedBarrelScrollTimer);
    speedBarrelPointer = {
      id: event.pointerId,
      startY: event.clientY,
      startScroll: dom.playerSpeedBarrel.scrollTop,
      didMove: false,
    };
    setSpeedBarrelSnapEnabled(false);
    dom.playerSpeedBarrel.setPointerCapture?.(event.pointerId);
  }

  function onSpeedBarrelPointerMove(event) {
    if (!speedBarrelPointer || event.pointerId !== speedBarrelPointer.id) return;
    const dy = event.clientY - speedBarrelPointer.startY;
    if (!speedBarrelPointer.didMove && Math.abs(dy) > 3) {
      speedBarrelPointer.didMove = true;
    }
    if (!speedBarrelPointer.didMove) return;
    event.preventDefault();
    speedBarrelSyncing = true;
    dom.playerSpeedBarrel.scrollTop = speedBarrelPointer.startScroll - dy;
    speedBarrelSyncing = false;
  }

  function onSpeedBarrelPointerUp(event) {
    if (!speedBarrelPointer || event.pointerId !== speedBarrelPointer.id) return;
    const didMove = speedBarrelPointer.didMove;
    const option = didMove
      ? null
      : event.target.closest?.(".full-player__speed-barrel-option");
    speedBarrelPointer = null;
    if (!didMove && option && dom.playerSpeedBarrel.contains(option)) {
      const rate = Number(option.dataset.rate);
      scrollSpeedBarrelToRate(rate, { smooth: true });
      commitSpeedBarrelSelection(rate);
      return;
    }
    settleSpeedBarrelSelection({ smooth: true });
  }

  function resetSpeedMenuPanelPosition() {
    const panel = dom.playerSpeedPanel;
    panel.style.position = "";
    panel.style.top = "";
    panel.style.left = "";
    panel.style.right = "";
    panel.style.width = "";
    panel.style.height = "";
    panel.style.bottom = "";
    panel.style.setProperty("--speed-row", "");
    delete panel.dataset.placement;
  }

  function positionSpeedMenuPanel() {
    const panel = dom.playerSpeedPanel;
    const toggleButton = dom.playerSpeedToggle;
    const rect = toggleButton.getBoundingClientRect();
    const row = Math.max(18, Math.round(rect.height));
    const width = Math.max(rect.width, 44);
    const height = row * 3;
    const left = rect.left + (rect.width / 2) - (width / 2);
    const top = rect.top + (rect.height / 2) - (height / 2);

    panel.style.setProperty("--speed-row", `${row}px`);
    panel.style.position = "fixed";
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${Math.max(8, left)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.top = `${Math.max(8, top)}px`;
    panel.dataset.placement = "overlay";
  }

  function closePlaybackSpeedMenu() {
    if (!speedMenuListeners) return;
    window.clearTimeout(speedBarrelScrollTimer);
    speedBarrelScrollTimer = null;
    speedBarrelPointer = null;
    setSpeedBarrelSnapEnabled(true);
    dom.playerSpeedToggle.setAttribute("aria-expanded", "false");
    dom.playerSpeedPanel.setAttribute("hidden", "");
    dom.playerSpeedControl.append(dom.playerSpeedPanel);
    dom.playerSpeedControl.classList.remove("is-open");
    resetSpeedMenuPanelPosition();
    document.removeEventListener("pointerdown", speedMenuListeners.outside, true);
    document.removeEventListener("click", speedMenuListeners.outside, true);
    window.removeEventListener("resize", speedMenuListeners.resize);
    dom.playerSpeedBarrel.removeEventListener("scroll", speedMenuListeners.scroll);
    speedMenuListeners = null;
    speedMenuIgnoreOutsideUntil = 0;
  }

  function openPlaybackSpeedMenu() {
    closePlaybackSpeedMenu();
    const currentRate = normalizePlaybackRate(audioController.getPlaybackRate?.());
    syncPlaybackSpeedUi(currentRate);
    dom.playerSpeedToggle.setAttribute("aria-expanded", "true");
    dom.playerSpeedPanel.removeAttribute("hidden");
    dom.playerSpeedControl.classList.add("is-open");
    document.body.append(dom.playerSpeedPanel);
    positionSpeedMenuPanel();
    scrollSpeedBarrelToRate(currentRate);
    speedMenuIgnoreOutsideUntil = Date.now() + 320;

    const listeners = {
      outside: (event) => {
        if (Date.now() < speedMenuIgnoreOutsideUntil) return;
        if (dom.playerSpeedControl.contains(event.target) || dom.playerSpeedPanel.contains(event.target)) return;
        closePlaybackSpeedMenu();
      },
      resize: () => closePlaybackSpeedMenu(),
      scroll: () => handleSpeedBarrelScroll(),
    };

    speedMenuListeners = listeners;
    dom.playerSpeedBarrel.addEventListener("scroll", listeners.scroll, { passive: true });
    window.setTimeout(() => {
      if (speedMenuListeners !== listeners) return;
      positionSpeedMenuPanel();
      scrollSpeedBarrelToRate(currentRate);
      document.addEventListener("pointerdown", listeners.outside, true);
      document.addEventListener("click", listeners.outside, true);
      window.addEventListener("resize", listeners.resize, { passive: true });
      const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;
      if (finePointer) dom.playerSpeedBarrel.focus({ preventScroll: true });
    }, 0);
  }

  function togglePlaybackSpeedMenu() {
    if (speedMenuListeners) closePlaybackSpeedMenu();
    else openPlaybackSpeedMenu();
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

  function renderFavorite() {
    const episode = playerState.getState().selectedEpisode;
    const isFavorite = Boolean(episode && favoritesStore.has(episode));
    dom.fullPlayerFavorite.setAttribute("aria-pressed", String(isFavorite));
    dom.fullPlayerFavorite.setAttribute(
      "aria-label",
      isFavorite ? "Remove from favorites" : "Add to favorites"
    );
  }

  function renderCommunitySignals() {
    const episode = playerState.getState().selectedEpisode;
    const signals = episode
      ? communitySignals?.getEpisodeSignals(episode.episodeKey)
      : { stars: null, views: null };
    const pending = !Number.isFinite(signals?.views);
    const viewsCount = pending ? null : formatViewSignal(signals.views, { compact: true });
    const viewsMarkup = pending ? VIEW_PENDING_MARK : viewsCount;
    dom.fullPlayerViews.innerHTML = `<span class="full-player__views-icon" aria-hidden="true">${VIEW_EYE_ICON}</span><span>${viewsMarkup}</span>`;
    dom.fullPlayerSignals.setAttribute("aria-label", pending ? "Views loading" : `${viewsCount} views`);
  }

  function getQueueWindow() {
    return playerState.getUpNextWindow(QUEUE_WINDOW_LIMIT, {
      skipEpisode: (episode) => isEpisodeCompleted(episode),
    });
  }

  function renderQueueMode(state) {
    const queueWindow = getQueueWindow();
    const canOpenQueue = Boolean(state.selectedEpisode && queueWindow.index >= 0 && queueWindow.total > 0);
    if (!canOpenQueue && fullPlayerMode === FULL_PLAYER_MODES.QUEUE) {
      setFullPlayerMode(FULL_PLAYER_MODES.PLAYER);
    } else {
      setFullPlayerMode(fullPlayerMode);
    }

    dom.playerQueueToggle.disabled = !canOpenQueue;
    renderQueuePanel(state, queueWindow);
  }

  function handleTranscriptAvailabilityChange(availability, episodeKey) {
    if (episodeKey !== playerState.getState().selectedEpisode?.episodeKey) return;
    if (availability === "unavailable" && fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT) {
      setFullPlayerMode(FULL_PLAYER_MODES.PLAYER);
    }
    if (availability === "available") {
      transcriptSearch.setTimeline(transcriptView.getTimeline());
    }
    transcriptSearch.syncRootVisibility();
    if (
      availability === "available"
      && playerState.getState().isExpanded
      && fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT
    ) {
      transcriptRestoreSynced = false;
      transcriptView.scheduleCenterRestore();
    }
    renderTranscriptControl();
  }

  function renderTranscriptMode(state) {
    renderTranscriptControl();
    transcriptView.setPlaybackActive(state.playbackStatus === PLAYBACK_STATUSES.PLAYING);
    const isTranscriptMode = fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT && state.isExpanded;
    const episodeKey = state.selectedEpisode?.episodeKey || "";
    if (episodeKey !== transcriptRestoreEpisodeKey) {
      transcriptRestoreEpisodeKey = episodeKey;
      transcriptRestoreSynced = false;
      transcriptRestoreSeenTime = 0;
    }
    if (!isTranscriptMode) return;
    if (transcriptView.getAvailability() !== "available") return;

    const playbackActive = ACTIVE_PLAYBACK_STATUSES.has(state.playbackStatus);
    if (playbackActive && transcriptRestoreSynced) return;

    const audioTime = audioController.getCurrentTime();
    const savedTime = playbackProgressStore.getSavedCurrentTime(episodeKey) ?? 0;
    const playbackTime = Math.max(audioTime, state.currentTime, savedTime);
    const audioPositionArrived = audioTime > 0 && Math.abs(audioTime - transcriptRestoreSeenTime) > 2;

    if (!transcriptRestoreSynced && playbackTime > 0) {
      if (transcriptRestoreSeenTime === 0 || audioPositionArrived) {
        transcriptRestoreSeenTime = playbackTime;
        if (transcriptView.syncToPlaybackPosition({ forceCenter: true, instant: true })) {
          transcriptRestoreSynced = true;
        } else {
          transcriptView.scheduleCenterRestore();
        }
        return;
      }
    }

    transcriptView.syncToPlaybackPosition({ forceCenter: false });
  }

  function renderTranscriptControl() {
    const availability = transcriptView.getAvailability();
    const isTranscriptMode = fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT;
    const hasEpisode = Boolean(playerState.getState().selectedEpisode);
    dom.playerTranscriptsToggle.disabled = !hasEpisode || availability === "unavailable";
    dom.playerTranscriptsToggle.setAttribute("aria-pressed", String(isTranscriptMode));
    dom.playerTranscriptsToggle.setAttribute(
      "aria-label",
      availability === "loading"
        ? "Loading transcript"
        : availability === "unavailable"
          ? "Transcript unavailable"
          : isTranscriptMode
            ? "Show Now Playing"
            : "Show transcript"
    );
  }

  function renderQueuePanel(state, queueWindow = getQueueWindow()) {
    const [currentItem = state.selectedEpisode, ...visibleUpcoming] = queueWindow.items;

    dom.fullPlayerQueueTitle.textContent = "Continue Playing";
    dom.fullPlayerQueueMeta.textContent = queueWindow.index >= 0
      ? `${queueWindow.index + 1} of ${queueWindow.total} · ${formatCollectionLabel(state.collectionId)}`
      : formatCollectionLabel(state.collectionId);

    renderCompactQueueRow(currentItem);

    if (fullPlayerMode === FULL_PLAYER_MODES.QUEUE) {
      const trackedQueueKeys = queueWindow.items
        .map((episode) => episode?.episodeKey)
        .filter(Boolean);
      communitySignals?.setTrackedEpisodeKeys("queue", trackedQueueKeys);
    } else {
      communitySignals?.setTrackedEpisodeKeys("queue", []);
    }

    if (queueReindexAnimationActive || queueRenderLocked) return;

    const rows = visibleUpcoming.map((episode) => createQueueListItem(episode));
    if (!rows.length) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "full-player__queue-empty";
      emptyItem.textContent = queueWindow.total ? "End of queue." : "Queue loading...";
      rows.push(emptyItem);
    }
    dom.fullPlayerQueueList.replaceChildren(...rows);
    rows.forEach((item) => {
      const row = item.querySelector?.(".episode-row");
      if (row) updateEpisodeRowMarquee(row, true);
    });
  }

  function refreshQueueEpisodeRow(row, episode, { isSelected = false } = {}) {
    if (!row || !episode) return;
    refreshEpisodeRow(row, episode, {
      ...queueRowOptions,
      isSelected,
    });
    updateEpisodeRowMarquee(row, true);
  }

  function refreshCompactFavorite() {
    if (!compactQueueRow) return;
    const episode = playerState.getState().selectedEpisode;
    if (!episode || compactQueueRow.dataset.episodeKey !== episode.episodeKey) return;
    updateEpisodeRowFavorite(compactQueueRow, episode, favoritesStore);
  }

  function renderCompactQueueRow(episode) {
    if (!episode) {
      compactQueueRow = null;
      dom.fullPlayerCompact.replaceChildren();
      return;
    }

    if (!compactQueueRow || compactQueueRow.dataset.episodeKey !== episode.episodeKey) {
      dom.fullPlayerCompact.replaceChildren();
      compactQueueRow = createEpisodeRow(episode, {
        ...queueRowOptions,
        isSelected: true,
        onActivate: () => setFullPlayerMode(FULL_PLAYER_MODES.PLAYER),
      });
      dom.fullPlayerCompact.append(compactQueueRow);
      updateEpisodeRowMarquee(compactQueueRow, true);
      return;
    }

    refreshQueueEpisodeRow(compactQueueRow, episode, { isSelected: true });
  }

  function createQueueListItem(episode) {
    const sourceStatus = getSourceStatusForEpisode(episode);
    const isReady = sourceStatus.id === SOURCE_STATUSES.READY;
    const isLocked = sourceStatus.id === SOURCE_STATUSES.RSS_REQUIRED;
    const item = document.createElement("li");
    item.className = "full-player__queue-item";
    item.dataset.episodeKey = episode.episodeKey;
    item.classList.toggle("is-locked", isLocked);
    item.classList.toggle("is-unavailable", !isReady && !isLocked);

    const row = createEpisodeRow(episode, {
      ...queueRowOptions,
      isSelected: false,
      onActivate: () => {
        animateQueueSelection(
          episode,
          isReady ? onPlayRequest : onSelectRequest,
          { deferRequest: !isReady },
        );
      },
    });
    item.append(row);
    return item;
  }

  function animateQueueSelection(episode, request, { deferRequest = true } = {}) {
    cancelQueueReindexAnimation({ render: false });
    const rows = [...dom.fullPlayerQueueList.querySelectorAll(".full-player__queue-item")];
    const selectedIndex = rows.findIndex((row) => row.dataset.episodeKey === episode.episodeKey);
    if (selectedIndex <= 0) {
      finishQueueMarkListened();
      void request(episode, getQueueRequestOptions());
      return;
    }

    const gap = parseFloat(window.getComputedStyle(dom.fullPlayerQueueList).rowGap) || 0;
    const removedRows = rows.slice(0, selectedIndex);
    const shiftDistance = removedRows.reduce(
      (total, row) => total + row.getBoundingClientRect().height + gap,
      0
    );

    removedRows.forEach((row) => row.classList.add("is-queue-removing"));
    rows.slice(selectedIndex).forEach((row) => {
      row.style.setProperty("--queue-shift", `-${shiftDistance}px`);
      row.classList.add("is-queue-shifting");
    });
    void dom.fullPlayerQueueList.offsetHeight;

    queueReindexAnimationActive = true;
    if (!deferRequest) {
      void request(episode, getQueueRequestOptions());
    }

    queueSelectionTimer = window.setTimeout(() => {
      queueSelectionTimer = null;
      resetQueueAnimationRows(rows);
      queueReindexAnimationActive = false;
      if (deferRequest) {
        finishQueueMarkListened();
        void request(episode, getQueueRequestOptions());
      } else {
        finishQueueMarkListened();
        renderQueuePanel(playerState.getState());
      }
    }, 190);
  }

  function animateQueueItemRemoval(episode, onComplete) {
    cancelQueueReindexAnimation({ render: false });
    const rows = [...dom.fullPlayerQueueList.querySelectorAll(".full-player__queue-item")];
    const removeIndex = rows.findIndex((row) => row.dataset.episodeKey === episode.episodeKey);
    if (removeIndex < 0) {
      onComplete?.();
      return;
    }

    const gap = parseFloat(window.getComputedStyle(dom.fullPlayerQueueList).rowGap) || 0;
    const removedRow = rows[removeIndex];
    const shiftDistance = removedRow.getBoundingClientRect().height + gap;

    removedRow.classList.add("is-queue-removing");
    rows.slice(removeIndex + 1).forEach((row) => {
      row.style.setProperty("--queue-shift", `-${shiftDistance}px`);
      row.classList.add("is-queue-shifting");
    });
    void dom.fullPlayerQueueList.offsetHeight;

    queueReindexAnimationActive = true;
    queueSelectionTimer = window.setTimeout(() => {
      queueSelectionTimer = null;
      resetQueueAnimationRows(rows);
      queueReindexAnimationActive = false;
      onComplete?.();
    }, 190);
  }

  function cancelQueueReindexAnimation({ render = true } = {}) {
    if (!queueReindexAnimationActive && !queueSelectionTimer) return;
    window.clearTimeout(queueSelectionTimer);
    queueSelectionTimer = null;
    resetQueueAnimationRows([...dom.fullPlayerQueueList.querySelectorAll(".full-player__queue-item")]);
    queueReindexAnimationActive = false;
    if (render) renderQueuePanel(playerState.getState());
  }

  function resetQueueAnimationRows(rows) {
    rows.forEach((row) => {
      row.classList.remove("is-queue-removing", "is-queue-shifting");
      row.style.removeProperty("--queue-shift");
    });
  }

  function getQueueRequestOptions() {
    return {
      collectionId: playerState.getState().collectionId,
      preserveExpanded: true,
    };
  }

  function normalizeFullPlayerMode(mode) {
    return mode === FULL_PLAYER_MODES.QUEUE || mode === FULL_PLAYER_MODES.TRANSCRIPT
      ? mode
      : FULL_PLAYER_MODES.PLAYER;
  }

  function syncFullPlayerModeFromState(state) {
    const nextMode = normalizeFullPlayerMode(state.fullPlayerMode);
    if (nextMode === fullPlayerMode) return;
    applyFullPlayerMode(nextMode, { persist: false });
  }

  function applyFullPlayerMode(mode, { persist = true } = {}) {
    const nextMode = normalizeFullPlayerMode(mode);
    if (nextMode !== FULL_PLAYER_MODES.QUEUE) {
      cancelQueueReindexAnimation({ render: false });
      queueMenuManager.closeEpisodeMenu();
      communitySignals?.setTrackedEpisodeKeys("queue", []);
    }
    if (nextMode !== FULL_PLAYER_MODES.PLAYER) {
      closePlaybackSpeedMenu();
    }
    fullPlayerMode = nextMode;
    const isQueueMode = fullPlayerMode === FULL_PLAYER_MODES.QUEUE;
    const isTranscriptMode = fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT;
    const isAlternateMode = isQueueMode || isTranscriptMode;
    dom.fullPlayer.dataset.mode = fullPlayerMode;
    dom.fullPlayerHero.inert = isAlternateMode;
    dom.fullPlayerHero.setAttribute("aria-hidden", String(isAlternateMode));
    dom.fullPlayerCompact.inert = !isAlternateMode;
    dom.fullPlayerCompact.setAttribute("aria-hidden", String(!isAlternateMode));
    dom.fullPlayerQueuePanel.inert = !isQueueMode;
    dom.fullPlayerQueuePanel.setAttribute("aria-hidden", String(!isQueueMode));
    dom.fullPlayerTranscriptPanel.inert = !isTranscriptMode;
    dom.fullPlayerTranscriptPanel.setAttribute("aria-hidden", String(!isTranscriptMode));
    dom.playerQueueToggle.setAttribute("aria-pressed", String(isQueueMode));
    dom.playerQueueToggle.setAttribute("aria-label", isQueueMode ? "Show Now Playing" : "Show Up Next");
    transcriptView.setModeActive(
      isTranscriptMode && playerState.getState().isExpanded
    );
    if (!isTranscriptMode) {
      transcriptSearch.handleModeInactive();
    } else {
      transcriptSearch.syncRootVisibility();
    }
    renderTranscriptControl();
    if (persist) playerState.setFullPlayerMode(fullPlayerMode);
  }

  function setFullPlayerMode(mode) {
    applyFullPlayerMode(mode, { persist: true });
  }

  function toggleQueueMode() {
    const state = playerState.getState();
    const queueWindow = getQueueWindow();
    if (!state.selectedEpisode || queueWindow.index < 0 || queueWindow.total === 0) return;
    setFullPlayerMode(
      fullPlayerMode === FULL_PLAYER_MODES.QUEUE ? FULL_PLAYER_MODES.PLAYER : FULL_PLAYER_MODES.QUEUE
    );
    renderQueuePanel(state, queueWindow);
  }

  function toggleTranscriptMode() {
    if (transcriptView.getAvailability() === "unavailable") return;
    setFullPlayerMode(
      fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT
        ? FULL_PLAYER_MODES.PLAYER
        : FULL_PLAYER_MODES.TRANSCRIPT
    );
  }

  function openTranscript() {
    if (transcriptView.getAvailability() === "unavailable") return;
    setFullPlayerMode(FULL_PLAYER_MODES.TRANSCRIPT);
    if (!playerState.getState().isExpanded) {
      expand();
    }
  }

  function primeTranscript(episodeKey, model) {
    transcriptView.primeTranscript(episodeKey, model);
  }

  function collapse() {
    if (!playerState.getState().isExpanded) return;
    closePlaybackSpeedMenu();
    setFullPlayerMode(FULL_PLAYER_MODES.PLAYER);
    playerState.setExpanded(false);
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected ? restoreFocusTo : dom.miniPlayerExpand;
      target.focus();
      restoreFocusTo = null;
    });
  }

  function setExpandedUi(isExpanded) {
    if (isDragging) return;
    if (!isExpanded) closePlaybackSpeedMenu();
    dom.fullPlayer.classList.toggle("is-open", isExpanded);
    dom.playerBackdrop.classList.toggle("is-open", isExpanded);
    dom.fullPlayer.setAttribute("aria-hidden", String(!isExpanded));
    dom.fullPlayer.inert = !isExpanded;
    document.body.classList.toggle("player-expanded", isExpanded);
    dom.app.inert = isExpanded || document.body.classList.contains("calendar-open");
    dom.miniPlayer.inert = isExpanded;
    transcriptView.setModeActive(
      isExpanded && fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT
    );
    if (!isExpanded) {
      transcriptSearch.handleModeInactive();
    } else if (fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT) {
      transcriptSearch.syncRootVisibility();
    }
    if (!isExpanded) wasExpanded = false;
  }

  function clampValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sheetHeight() {
    return dom.fullPlayer.getBoundingClientRect().height || window.innerHeight;
  }

  function setSheetTranslate(translate) {
    const height = gesture?.height || window.innerHeight;
    dragTranslate = clampValue(translate, 0, height);
    const progress = height > 0 ? 1 - (dragTranslate / height) : 0;
    dom.fullPlayer.style.transform = `translateY(${dragTranslate}px)`;
    dom.playerBackdrop.style.opacity = String(clampValue(progress, 0, 1));
  }

  function startDragVisuals() {
    isDragging = true;
    dom.fullPlayer.hidden = false;
    dom.playerBackdrop.hidden = false;
    dom.fullPlayer.inert = false;
    dom.fullPlayer.setAttribute("aria-hidden", "false");
    dom.fullPlayer.classList.add("is-dragging");
    dom.playerBackdrop.classList.add("is-dragging");
    document.body.classList.add("player-dragging");
  }

  function endDragVisuals() {
    isDragging = false;
    dom.fullPlayer.classList.remove("is-dragging");
    dom.playerBackdrop.classList.remove("is-dragging");
    document.body.classList.remove("player-dragging");
    dom.fullPlayer.style.transform = "";
    dom.playerBackdrop.style.opacity = "";
  }

  function onDragPointerDown(mode, event) {
    if (gesture || isDragging) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const state = playerState.getState();
    if (!state.selectedEpisode) return;
    if (mode === "expand" && state.isExpanded) return;
    if (mode === "collapse" && !state.isExpanded) return;

    if (mode === "collapse") {
      const onHandle = Boolean(event.target.closest(".full-player__collapse"));
      if (!onHandle) {
        if (dom.fullPlayer.scrollTop > 0) return;
        if (event.target.closest("button, input, a, .full-player__aside, .full-player__queue-panel, .full-player__transcript-panel")) return;
      }
    }

    gesture = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp || performance.now(),
      velocity: 0,
      height: sheetHeight(),
      pointerId: event.pointerId,
      target: event.currentTarget,
      active: false,
    };
  }

  function activateGesture(event) {
    gesture.active = true;
    startDragVisuals();
    setSheetTranslate(gesture.mode === "expand" ? gesture.height : 0);
    gesture.target.setPointerCapture?.(event.pointerId);
  }

  function onDragPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dyDown = event.clientY - gesture.startY;
    const dyUp = -dyDown;

    if (!gesture.active) {
      const horizontal = Math.abs(dx);
      if (gesture.mode === "expand") {
        if (dyUp > DRAG_ACTIVATE_PX && dyUp > horizontal) {
          activateGesture(event);
        } else if (dyDown > DRAG_ACTIVATE_PX) {
          gesture = null;
          return;
        } else {
          return;
        }
      } else if (dyDown > DRAG_ACTIVATE_PX && dyDown > horizontal) {
        activateGesture(event);
      } else if (dyUp > DRAG_ACTIVATE_PX) {
        gesture = null;
        return;
      } else {
        return;
      }
    }

    event.preventDefault();
    const height = gesture.height;
    const translate = gesture.mode === "expand"
      ? height - Math.max(0, dyUp)
      : Math.max(0, dyDown);
    setSheetTranslate(translate);

    const now = event.timeStamp || performance.now();
    const dt = now - gesture.lastTime;
    if (dt > 0) gesture.velocity = (event.clientY - gesture.lastY) / dt;
    gesture.lastY = event.clientY;
    gesture.lastTime = now;
  }

  function onDragPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if (!g.active) return;

    g.target.releasePointerCapture?.(event.pointerId);
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;

    const height = g.height;
    const progress = height > 0 ? 1 - (dragTranslate / height) : 0;
    const velocity = g.velocity;

    let shouldOpen;
    if (velocity < -DRAG_VELOCITY_THRESHOLD) shouldOpen = true;
    else if (velocity > DRAG_VELOCITY_THRESHOLD) shouldOpen = false;
    else shouldOpen = g.mode === "expand"
      ? progress > DRAG_COMPLETE_FRACTION
      : progress > (1 - DRAG_COMPLETE_FRACTION);

    settleDrag(shouldOpen);
  }

  function settleDrag(open) {
    endDragVisuals();
    if (open) {
      if (!playerState.getState().isExpanded) {
        restoreFocusTo = dom.miniPlayerExpand;
        playerState.setExpanded(true);
      } else {
        setExpandedUi(true);
      }
    } else if (playerState.getState().isExpanded) {
      collapse();
    } else {
      setExpandedUi(false);
    }
  }

  function maybeSwallowClick(event) {
    if (performance.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
      suppressClickUntil = 0;
    }
  }

  function seekBy(offset, surface) {
    if (!canSeek(playerState.getState())) return;

    const seekTime = audioController.seekBy(offset);
    if (seekTime === null) return;

    const total = extendSeekBurst(offset);
    if (activeSeekTooltipSurface && activeSeekTooltipSurface !== surface) {
      hideSeekTooltip(activeSeekTooltipSurface);
    }
    activeSeekTooltipSurface = surface;
    showTimelineTooltip(surface, formatSeekOffset(total), seekTime, SEEK_BURST_MS);
  }

  function showTimelineTooltip(surface, label, seekTime, hideAfterMs = SEEK_BURST_MS) {
    const element = getSeekTooltipElement(surface);
    const duration = playerState.getState().duration;
    const percent = duration > 0 ? (seekTime / duration) * 100 : 0;
    window.clearTimeout(tooltipTimers.get(element));
    element.textContent = label;
    element.style.setProperty("--scrub-position", `${percent}%`);
    element.hidden = false;
    tooltipTimers.set(element, window.setTimeout(() => {
      element.hidden = true;
    }, hideAfterMs));
  }

  function timelineValueFromClientX(clientX) {
    const input = dom.playerTimeline;
    const rect = input.getBoundingClientRect();
    const max = Number(input.max) || 0;
    if (!max || rect.width <= 0) return 0;
    const ratio = clampValue((clientX - rect.left) / rect.width, 0, 1);
    return ratio * max;
  }

  function updateScrubFromPointer(event) {
    const value = timelineValueFromClientX(event.clientX);
    dom.playerTimeline.value = String(value);
    updateScrubPreview(value);
  }

  function beginScrub(event) {
    if (dom.playerTimeline.disabled) return;
    clearBurstContext();
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(tooltipTimers.get(dom.playerTimelineTooltip));
    isScrubbing = true;
    suppressNextChange = false;
    scrubPointerId = event.pointerId;
    dom.playerTimeline.setPointerCapture?.(event.pointerId);
    if (fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT && playerState.getState().isExpanded) {
      transcriptView.setScrubbing(true);
    }
    updateScrubFromPointer(event);
  }

  function onScrubPointerMove(event) {
    if (!isScrubbing || event.pointerId !== scrubPointerId) return;
    event.preventDefault();
    updateScrubFromPointer(event);
  }

  function endScrub(event, commit) {
    if (!isScrubbing) return;
    if (event?.pointerId !== undefined && scrubPointerId !== null && event.pointerId !== scrubPointerId) return;
    dom.playerTimeline.releasePointerCapture?.(scrubPointerId);
    scrubPointerId = null;
    if (commit) commitScrub();
    else cancelScrub();
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
    if (fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT && playerState.getState().isExpanded) {
      transcriptView.update(scrubPreviewTime, { scrubbing: true });
    }
  }

  function commitScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubPointerId = null;
    suppressNextChange = true;
    dom.playerTimelineTooltip.hidden = true;
    if (fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT) {
      transcriptView.setScrubbing(false);
    }
    audioController.seek(scrubPreviewTime);
    window.setTimeout(() => {
      suppressNextChange = false;
    }, 0);
  }

  function cancelScrub() {
    if (!isScrubbing) return;
    if (scrubPointerId !== null) {
      dom.playerTimeline.releasePointerCapture?.(scrubPointerId);
      scrubPointerId = null;
    }
    isScrubbing = false;
    dom.playerTimelineTooltip.hidden = true;
    if (fullPlayerMode === FULL_PLAYER_MODES.TRANSCRIPT) {
      transcriptView.setScrubbing(false);
      transcriptView.update(playerState.getState().currentTime, { forceCenter: true });
    }
    renderTimeline(playerState.getState());
  }

  function trapFocus(event) {
    if (event.key === "Escape") {
      if (speedMenuListeners) {
        closePlaybackSpeedMenu();
        dom.playerSpeedToggle.focus();
        return;
      }
      collapse();
      return;
    }
    if (event.key !== "Tab" || !playerState.getState().isExpanded) return;

    const focusable = [...dom.fullPlayer.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.closest("[aria-hidden='true']") && element.offsetParent !== null);
    if (speedMenuListeners) {
      focusable.push(dom.playerSpeedBarrel);
    }
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
  dom.miniPlayer.addEventListener("pointerdown", (event) => onDragPointerDown("expand", event));
  dom.fullPlayer.addEventListener("pointerdown", (event) => onDragPointerDown("collapse", event));
  dom.miniPlayer.addEventListener("click", maybeSwallowClick, true);
  dom.fullPlayer.addEventListener("click", maybeSwallowClick, true);
  window.addEventListener("pointermove", (event) => {
    if (isScrubbing) {
      onScrubPointerMove(event);
      return;
    }
    onDragPointerMove(event);
  }, { passive: false });
  window.addEventListener("pointerup", (event) => {
    if (isScrubbing) {
      endScrub(event, true);
      return;
    }
    onDragPointerUp(event);
  });
  window.addEventListener("pointercancel", (event) => {
    if (isScrubbing) {
      endScrub(event, false);
      return;
    }
    onDragPointerUp(event);
  });
  dom.playerSeekBack.addEventListener("click", () => seekBy(-SEEK_BACK_SECONDS, "full"));
  dom.playerSeekForward.addEventListener("click", () => seekBy(SEEK_FORWARD_SECONDS, "full"));
  dom.miniPlayerSeekBack.addEventListener("click", () => seekBy(-SEEK_BACK_SECONDS, "mini"));
  dom.miniPlayerSeekForward.addEventListener("click", () => seekBy(SEEK_FORWARD_SECONDS, "mini"));
  dom.playerSpeedToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePlaybackSpeedMenu();
  });
  dom.playerSpeedPanel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  dom.playerSpeedBarrel.addEventListener("pointerdown", onSpeedBarrelPointerDown);
  dom.playerSpeedBarrel.addEventListener("pointermove", onSpeedBarrelPointerMove, { passive: false });
  dom.playerSpeedBarrel.addEventListener("pointerup", onSpeedBarrelPointerUp);
  dom.playerSpeedBarrel.addEventListener("pointercancel", onSpeedBarrelPointerUp);
  dom.playerSpeedBarrel.addEventListener("lostpointercapture", onSpeedBarrelPointerUp);
  dom.playerSpeedBarrel.addEventListener("keydown", (event) => {
    if (!speedMenuListeners) return;
    const currentIndex = getSpeedBarrelIndexFromScroll();
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      const nextIndex = Math.max(0, currentIndex - 1);
      const rate = PLAYBACK_RATES[nextIndex];
      scrollSpeedBarrelToRate(rate, { smooth: true });
      commitSpeedBarrelSelection(rate);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      const nextIndex = Math.min(PLAYBACK_RATES.length - 1, currentIndex + 1);
      const rate = PLAYBACK_RATES[nextIndex];
      scrollSpeedBarrelToRate(rate, { smooth: true });
      commitSpeedBarrelSelection(rate);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      scrollSpeedBarrelToRate(PLAYBACK_RATES[0], { smooth: true });
      commitSpeedBarrelSelection(PLAYBACK_RATES[0]);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const rate = PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
      scrollSpeedBarrelToRate(rate, { smooth: true });
      commitSpeedBarrelSelection(rate);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      closePlaybackSpeedMenu();
      dom.playerSpeedToggle.focus();
    }
  });
  function handlePlaybackControl(event) {
    const state = playerState.getState();
    if (state.sourceStatus?.id === SOURCE_STATUSES.RSS_REQUIRED) {
      onLockedRequest(state.selectedEpisode, event.currentTarget);
      return;
    }
    void audioController.toggle();
  }

  dom.playerPlay.addEventListener("click", handlePlaybackControl);
  dom.miniPlayerPlay.addEventListener("click", handlePlaybackControl);
  dom.playerQueueToggle.addEventListener("click", toggleQueueMode);
  dom.playerTranscriptsToggle.addEventListener("click", toggleTranscriptMode);
  (timelineScrubber || dom.playerTimeline).addEventListener("pointerdown", beginScrub);
  dom.playerTimeline.addEventListener("input", (event) => {
    if (isScrubbing) updateScrubPreview(event.currentTarget.value);
    else {
      clearBurstContext();
      audioController.seek(event.currentTarget.value);
    }
  });
  dom.playerTimeline.addEventListener("change", (event) => {
    if (!isScrubbing && !suppressNextChange) {
      clearBurstContext();
      audioController.seek(event.currentTarget.value);
    }
  });
  dom.playerTimeline.addEventListener("blur", cancelScrub);
  dom.fullPlayerFavorite.addEventListener("click", () => {
    const episode = playerState.getState().selectedEpisode;
    if (episode) onFavoriteToggle?.(episode);
  });
  document.addEventListener("keydown", trapFocus);
  window.addEventListener("resize", () => {
    requestAnimationFrame(updateFullPlayerTitleMarquee);
    if (fullPlayerMode !== FULL_PLAYER_MODES.PLAYER && compactQueueRow) {
      const episode = playerState.getState().selectedEpisode;
      if (episode) refreshQueueEpisodeRow(compactQueueRow, episode, { isSelected: true });
    }
  });
  onRegisterQueueRefresh(() => {
    if (fullPlayerMode !== FULL_PLAYER_MODES.QUEUE) return;
    if (queueReindexAnimationActive || queueRenderLocked) return;
    renderQueuePanel(playerState.getState());
  });
  playerState.subscribe(render);
  favoritesStore.subscribe(() => {
    renderFavorite();
    if (fullPlayerMode === FULL_PLAYER_MODES.QUEUE) {
      renderQueuePanel(playerState.getState());
      return;
    }
    refreshCompactFavorite();
  });
  communitySignals?.subscribe((changedKeys) => {
    const episodeKey = playerState.getState().selectedEpisode?.episodeKey;
    if (episodeKey && (!changedKeys.size || changedKeys.has(episodeKey))) {
      renderCommunitySignals();
    }

    if (fullPlayerMode !== FULL_PLAYER_MODES.QUEUE) return;

    if (compactQueueRow) {
      const compactKey = compactQueueRow.dataset.episodeKey;
      if (compactKey && (!changedKeys.size || changedKeys.has(compactKey))) {
        const episode = playerState.getState().selectedEpisode;
        if (episode?.episodeKey === compactKey) {
          updateEpisodeRowSignals(compactQueueRow, episode, communitySignals);
        }
      }
    }

    for (const item of dom.fullPlayerQueueList.children) {
      const row = item.querySelector?.(".episode-row");
      const rowKey = row?.dataset?.episodeKey || item.dataset?.episodeKey;
      if (!row || !rowKey) continue;
      if (changedKeys.size && !changedKeys.has(rowKey)) continue;
      const episode = getQueueWindow().items.find((entry) => entry.episodeKey === rowKey);
      if (episode) updateEpisodeRowSignals(row, episode, communitySignals);
    }
  });

  return {
    collapse,
    expand,
    openTranscript,
    primeTranscript,
  };
}

function isPlayable(state) {
  return Boolean(state.source?.url) && state.sourceStatus?.id === SOURCE_STATUSES.READY;
}

function canSeek(state) {
  if (!isPlayable(state)) return false;
  if (state.playbackStatus === PLAYBACK_STATUSES.LOADING_SOURCE) return false;
  const duration = Number.isFinite(state.duration) ? state.duration : 0;
  return duration > 0;
}

function formatMiniPlayerSubtitle(episode) {
  const sectionType = episode.paytch === "PAYTCH" ? "PAYTCH" : (episode.type || "MSSP");
  return `${sectionType} - ${episode.date || "Unknown date"}`;
}

function formatCollectionLabel(collectionId) {
  if (collectionId === "anthology") return "The Holy Trinity";
  if (collectionId === "old") return "The Old Testament";
  if (collectionId === "new") return "The New Testament";
  if (collectionId === "paytch") return "The PAYTCH";
  return "Current queue";
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
