import { PLAYBACK_STATUSES } from "./playerState.js";
import { SOURCE_STATUSES } from "./sourceStatus.js";

const SEEK_BACK_SECONDS = 15;
const SEEK_FORWARD_SECONDS = 30;
const SEEK_BURST_MS = 1200;
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
const QUEUE_WINDOW_LIMIT = 20;
const FULL_PLAYER_MODES = Object.freeze({
  PLAYER: "player",
  QUEUE: "queue",
});

export function createPlayerView({
  dom,
  playerState,
  audioController,
  favoritesStore,
  getSourceStatusForEpisode = () => ({ id: SOURCE_STATUSES.MISSING, label: "Source unavailable" }),
  onSelectRequest = () => {},
  onPlayRequest = () => {},
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
  const timelineScrubber = dom.playerTimeline.closest(".player-timeline__scrubber");
  const miniPlayerEpisode = dom.miniPlayerTitle.querySelector(".mini-player__episode");
  const miniPlayerTitleText = dom.miniPlayerTitle.querySelector(".mini-player__title-text");
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

  function render(state) {
    const episode = state.selectedEpisode;
    const hasEpisode = Boolean(episode);
    dom.miniPlayer.hidden = !hasEpisode;
    dom.fullPlayer.hidden = !hasEpisode;
    dom.playerBackdrop.hidden = !hasEpisode;
    document.body.classList.toggle("has-player", hasEpisode);

    if (!hasEpisode) {
      maybeResetBurstOnContextChange(state, null);
      setExpandedUi(false);
      return;
    }

    maybeResetBurstOnContextChange(state, episode);

    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const accessLabel = episode.paytch === "PAYTCH" ? "PAYTCH" : "Public";
    const source = state.sourceStatus;
    const playable = isPlayable(state);

    if (playable && state.playbackStatus === PLAYBACK_STATUSES.READY && state.duration === 0) {
      void audioController.loadSelected({ playbackIntent: false });
    }

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
    dom.fullPlayerEyebrow.textContent = `${episode.type || "MSSP"} ${accessLabel} ${episodeLabel}`;
    dom.fullPlayerTitle.textContent = episode.title || "Untitled episode";
    dom.fullPlayerMeta.textContent = `${episode.date || "Unknown date"} · ${accessLabel}`;
    dom.fullPlayerCompactCover.src = episode.coverUrl;
    dom.fullPlayerCompactCover.alt = "";
    dom.fullPlayerCompactTitle.textContent = formatQueueTitle(episode);
    dom.fullPlayerCompactMeta.textContent = formatQueueMeta(episode);
    dom.fullPlayerCompact.setAttribute("aria-label", `Show Now Playing for ${episode.title || "selected episode"}`);
    renderFavorite();
    dom.fullPlayer.classList.toggle("is-playback-active", ACTIVE_PLAYBACK_STATUSES.has(state.playbackStatus));

    const showStatusPanel = !playable || Boolean(state.playbackError);
    dom.fullPlayerStatusPanel.hidden = !showStatusPanel;
    dom.fullPlayerStatus.textContent = state.playbackError ? "Unable to play audio." : source.label;
    dom.fullPlayerStatusDetail.textContent = state.playbackError ? "Tap Play to retry." : source.detail;

    dom.miniPlayerPlay.disabled = !playable;
    dom.playerPlay.disabled = !playable;
    renderTimeline(state);

    renderPlaybackControl(dom.miniPlayerPlay, source, state.playbackRequested);
    renderPlaybackControl(dom.playerPlay, source, state.playbackRequested);
    renderQueueMode(state);
    setExpandedUi(state.isExpanded);
    if (state.isExpanded && !wasExpanded) {
      requestAnimationFrame(() => dom.fullPlayerCollapse.focus());
    }
    wasExpanded = state.isExpanded;
  }

  function renderTimeline(state) {
    const seekable = canSeek(state);
    const metadataLoading = state.playbackStatus === PLAYBACK_STATUSES.LOADING_SOURCE;
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

  function renderQueueMode(state) {
    const queueWindow = playerState.getUpNextWindow(QUEUE_WINDOW_LIMIT);
    const canOpenQueue = Boolean(state.selectedEpisode && queueWindow.index >= 0 && queueWindow.total > 0);
    if (!canOpenQueue && fullPlayerMode === FULL_PLAYER_MODES.QUEUE) {
      setFullPlayerMode(FULL_PLAYER_MODES.PLAYER);
    } else {
      setFullPlayerMode(fullPlayerMode);
    }

    dom.playerQueueToggle.disabled = !canOpenQueue;
    renderQueuePanel(state, queueWindow);
  }

  function renderQueuePanel(state, queueWindow = playerState.getUpNextWindow(QUEUE_WINDOW_LIMIT)) {
    const [currentItem = state.selectedEpisode, ...upcomingItems] = queueWindow.items;
    if (currentItem) {
      dom.fullPlayerCompactCover.src = currentItem.coverUrl;
      dom.fullPlayerCompactTitle.textContent = formatQueueTitle(currentItem);
      dom.fullPlayerCompactMeta.textContent = formatQueueMeta(currentItem);
    }

    dom.fullPlayerQueueTitle.textContent = "Continue Playing";
    dom.fullPlayerQueueMeta.textContent = queueWindow.index >= 0
      ? `${queueWindow.index + 1} of ${queueWindow.total} · ${formatCollectionLabel(state.collectionId)}`
      : formatCollectionLabel(state.collectionId);

    const rows = upcomingItems.map((episode) => createQueueRow(episode));
    if (!rows.length) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "full-player__queue-empty";
      emptyItem.textContent = queueWindow.total ? "End of queue." : "Queue loading...";
      rows.push(emptyItem);
    }
    dom.fullPlayerQueueList.replaceChildren(...rows);
  }

  function createQueueRow(episode) {
    const sourceStatus = getSourceStatusForEpisode(episode);
    const isReady = sourceStatus.id === SOURCE_STATUSES.READY;
    const isLocked = sourceStatus.id === SOURCE_STATUSES.RSS_REQUIRED;
    const item = document.createElement("li");
    item.className = "full-player__queue-item";
    item.classList.toggle("is-locked", isLocked);
    item.classList.toggle("is-unavailable", !isReady && !isLocked);

    const bodyButton = document.createElement("button");
    bodyButton.className = "full-player__queue-body";
    bodyButton.type = "button";
    bodyButton.setAttribute("aria-label", `Select ${episode.title || "episode"}`);
    bodyButton.addEventListener("click", () => {
      void onSelectRequest(episode, getQueueRequestOptions());
    });

    const cover = document.createElement("img");
    cover.src = episode.coverUrl;
    cover.alt = "";
    bodyButton.append(cover);

    const copy = document.createElement("span");
    copy.className = "full-player__queue-copy";
    const title = document.createElement("span");
    title.className = "full-player__queue-item-title";
    title.textContent = formatQueueTitle(episode);
    const meta = document.createElement("span");
    meta.className = "full-player__queue-item-meta";
    meta.textContent = formatQueueMeta(episode);
    copy.append(title, meta);
    bodyButton.append(copy);

    const actionButton = document.createElement("button");
    actionButton.className = "full-player__queue-action";
    actionButton.type = "button";
    actionButton.innerHTML = isLocked ? LOCK_ICON : PLAY_ICON;
    actionButton.classList.toggle("is-locked", isLocked);
    actionButton.classList.toggle("is-unavailable", !isReady && !isLocked);
    actionButton.setAttribute(
      "aria-label",
      isReady
        ? `Play ${episode.title || "episode"}`
        : isLocked
          ? `Connect Patreon RSS for ${episode.title || "episode"}`
          : `Open player for ${episode.title || "episode"}`
    );
    actionButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const request = isReady ? onPlayRequest : onSelectRequest;
      void request(episode, getQueueRequestOptions());
    });

    item.append(bodyButton, actionButton);
    return item;
  }

  function getQueueRequestOptions() {
    return {
      collectionId: playerState.getState().collectionId,
      preserveExpanded: true,
    };
  }

  function setFullPlayerMode(mode) {
    fullPlayerMode = mode === FULL_PLAYER_MODES.QUEUE ? FULL_PLAYER_MODES.QUEUE : FULL_PLAYER_MODES.PLAYER;
    const isQueueMode = fullPlayerMode === FULL_PLAYER_MODES.QUEUE;
    dom.fullPlayer.dataset.mode = fullPlayerMode;
    dom.fullPlayerHero.inert = isQueueMode;
    dom.fullPlayerHero.setAttribute("aria-hidden", String(isQueueMode));
    dom.fullPlayerCompact.inert = !isQueueMode;
    dom.fullPlayerCompact.setAttribute("aria-hidden", String(!isQueueMode));
    dom.fullPlayerQueuePanel.inert = !isQueueMode;
    dom.fullPlayerQueuePanel.setAttribute("aria-hidden", String(!isQueueMode));
    dom.playerQueueToggle.setAttribute("aria-pressed", String(isQueueMode));
    dom.playerQueueToggle.setAttribute("aria-label", isQueueMode ? "Show Now Playing" : "Show Up Next");
  }

  function toggleQueueMode() {
    const state = playerState.getState();
    const queueWindow = playerState.getUpNextWindow(QUEUE_WINDOW_LIMIT);
    if (!state.selectedEpisode || queueWindow.index < 0 || queueWindow.total === 0) return;
    setFullPlayerMode(
      fullPlayerMode === FULL_PLAYER_MODES.QUEUE ? FULL_PLAYER_MODES.PLAYER : FULL_PLAYER_MODES.QUEUE
    );
    renderQueuePanel(state, queueWindow);
  }

  function collapse() {
    if (!playerState.getState().isExpanded) return;
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
    dom.fullPlayer.classList.toggle("is-open", isExpanded);
    dom.playerBackdrop.classList.toggle("is-open", isExpanded);
    dom.fullPlayer.setAttribute("aria-hidden", String(!isExpanded));
    dom.fullPlayer.inert = !isExpanded;
    document.body.classList.toggle("player-expanded", isExpanded);
    dom.app.inert = isExpanded || document.body.classList.contains("calendar-open");
    dom.miniPlayer.inert = isExpanded;
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
        if (event.target.closest("button, input, a, .full-player__timeline, .full-player__queue-panel")) return;
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
  }

  function commitScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubPointerId = null;
    suppressNextChange = true;
    dom.playerTimelineTooltip.hidden = true;
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
    renderTimeline(playerState.getState());
  }

  function trapFocus(event) {
    if (event.key === "Escape") {
      collapse();
      return;
    }
    if (event.key !== "Tab" || !playerState.getState().isExpanded) return;

    const focusable = [...dom.fullPlayer.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.closest("[aria-hidden='true']") && element.offsetParent !== null);
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
  dom.playerPlay.addEventListener("click", () => audioController.toggle());
  dom.miniPlayerPlay.addEventListener("click", () => audioController.toggle());
  dom.playerQueueToggle.addEventListener("click", toggleQueueMode);
  dom.fullPlayerCompact.addEventListener("click", () => setFullPlayerMode(FULL_PLAYER_MODES.PLAYER));
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
    if (episode) favoritesStore.toggle(episode);
  });
  document.addEventListener("keydown", trapFocus);
  setFullPlayerMode(FULL_PLAYER_MODES.PLAYER);
  playerState.subscribe(render);
  favoritesStore.subscribe(renderFavorite);

  return {
    collapse,
    expand,
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

function formatQueueTitle(episode) {
  const prefix = episode?.episode ? `Ep ${episode.episode}` : "Extra";
  return `${prefix} - ${episode?.title || "Untitled episode"}`;
}

function formatQueueMeta(episode) {
  const parts = [];
  if (episode?.date) parts.push(episode.date);
  const duration = formatDurationLabel(episode?.durationSeconds);
  if (duration) parts.push(duration);
  if (episode?.paytch === "PAYTCH") parts.push("PAYTCH");
  return parts.join(" · ");
}

function formatDurationLabel(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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
