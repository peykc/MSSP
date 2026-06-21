const SILENCE_THRESHOLD_SECONDS = 3;
const SPOKEN_HOLD_SECONDS = 0.5;
const OVERSCAN = 15;
const OVERSCAN_DETACHED_DOWN = 48;
const OVERSCAN_DETACHED_UP = 18;
const FOLLOW_PIN_UP = 3;
const FOLLOW_PIN_DOWN = 12;
const FOLLOW_PREFETCH_AHEAD = 5;
const HYDRATE_BATCH_SIZE = 48;
const SCROLL_AHEAD_HYDRATE = 24;
const ESTIMATE_HEIGHT_MARGIN = 1.2;
const WIDTH_EPSILON = 2;
const PASSAGE_MARGIN = 28;
const SPEAKER_CHANGE_EXTRA = 0;

const AVAILABILITY = Object.freeze({
  IDLE: "idle",
  PENDING: "pending",
  LOADING: "loading",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

export function createTranscriptView({
  dom,
  audioController,
  getPlaybackTime = () => audioController.getCurrentTime(),
  onAvailabilityChange = () => {},
  onCenterRestoreComplete = () => {},
  onBeforeApplyTranscript: initialBeforeApplyTranscript = () => {},
}) {
  let onBeforeApplyTranscript = initialBeforeApplyTranscript;
  const cache = new Map();
  let selectedEpisodeKey = "";
  let loadToken = 0;
  let availability = AVAILABILITY.IDLE;
  let timeline = [];
  let entryOffsets = [];
  let entryHeights = [];
  let entryMeasured = [];
  let totalContentHeight = 0;
  let mountedByIndex = new Map();
  let entryResizeObservers = new Map();
  let activeEntryIndex = -1;
  let activeWordIndex = -1;
  let modeActive = false;
  let playbackActive = false;
  let following = true;
  let pendingCenterRestore = false;
  let restoreAttemptId = 0;
  let frameId = null;
  let renderFrameId = null;
  let programmaticScrollTimer = null;
  let searchScrollTimer = null;
  let lastLayoutWidth = 0;
  let forcedVisibleStart = -1;
  let forcedVisibleEnd = -1;
  let layoutGaps = { passage: PASSAGE_MARGIN, speaker: SPEAKER_CHANGE_EXTRA, silence: 0 };
  let followScrollFrameId = null;
  let followingListeners = new Set();
  let searchMatches = [];
  let searchActiveMatchIndex = -1;
  let lastScrollTop = 0;
  let scrollDirection = 0;
  let estimateMetrics = null;
  let measureContainer = null;
  let hydrateToken = 0;
  let hydrateFrameActive = false;
  let hydrateForward = 0;
  let hydrateBackward = -1;
  let hydratePhase = "forward";
  let passageTouchStartY = null;
  let playbackPinStart = -1;
  let playbackPinEnd = -1;
  let deferredHeightUpdates = new Map();
  let scrollHydrateFrameId = null;
  const PASSAGE_TOUCH_SCROLL_THRESHOLD = 8;

  function refreshLayoutGaps() {
    const probePassage = document.createElement("button");
    probePassage.className = "transcript-passage";
    probePassage.type = "button";
    probePassage.textContent = ".";
    probePassage.setAttribute("aria-hidden", "true");
    probePassage.style.visibility = "hidden";
    probePassage.style.pointerEvents = "none";
    dom.fullPlayerTranscriptItems.append(probePassage);
    layoutGaps.passage = Number.parseFloat(getComputedStyle(probePassage).paddingBottom) || PASSAGE_MARGIN;

    const probeSilence = document.createElement("div");
    probeSilence.className = "transcript-silence";
    probeSilence.setAttribute("aria-hidden", "true");
    probeSilence.style.visibility = "hidden";
    probeSilence.style.pointerEvents = "none";
    const silenceScale = document.createElement("span");
    silenceScale.className = "transcript-silence__scale";
    silenceScale.append(document.createElement("span"));
    probeSilence.append(silenceScale);
    dom.fullPlayerTranscriptItems.append(probeSilence);
    layoutGaps.silence = probeSilence.offsetHeight;

    probePassage.remove();
    probeSilence.remove();
  }

  function getAvailability() {
    return availability;
  }

  function setAvailability(nextAvailability) {
    if (availability === nextAvailability) return;
    availability = nextAvailability;
    onAvailabilityChange(nextAvailability, selectedEpisodeKey);
  }

  function isStale(requestId, episodeKey) {
    return requestId !== loadToken || episodeKey !== selectedEpisodeKey;
  }

  function setSelectedEpisode(episode) {
    const episodeKey = episode?.episodeKey || "";
    if (episodeKey === selectedEpisodeKey) return;

    selectedEpisodeKey = episodeKey;
    loadToken += 1;
    resetTranscript();

    if (!episodeKey) {
      setAvailability(AVAILABILITY.IDLE);
      renderMessage("No transcript selected.");
      return;
    }

    setAvailability(AVAILABILITY.PENDING);
    clearVirtualDom();
    if (modeActive) {
      void loadTranscript();
    }
  }

  async function loadTranscript() {
    const episodeKey = selectedEpisodeKey;
    if (!episodeKey) return;
    if (availability === AVAILABILITY.AVAILABLE && timeline.length) return;
    if (availability === AVAILABILITY.LOADING) return;

    const requestId = ++loadToken;
    setAvailability(AVAILABILITY.LOADING);
    renderMessage("Loading transcript…");

    const cached = cache.get(episodeKey);
    if (cached) {
      if (isStale(requestId, episodeKey)) return;
      applyTranscript(cached);
      return;
    }

    try {
      const response = await fetch(`./data/transcripts/${encodeURIComponent(episodeKey)}.json`);
      if (isStale(requestId, episodeKey)) return;
      if (!response.ok) {
        setUnavailable(response.status === 404 ? "Transcript unavailable." : "Could not load transcript.");
        return;
      }

      const payload = await response.json();
      const model = buildTranscriptTimeline(payload);
      if (!model.length) throw new Error("Transcript contains no timed words.");
      if (isStale(requestId, episodeKey)) return;

      cache.set(episodeKey, model);
      applyTranscript(model);
    } catch (error) {
      if (isStale(requestId, episodeKey)) return;
      console.warn("[MSSP] Transcript unavailable.", error);
      setUnavailable("Transcript unavailable.");
    }
  }

  function applyTranscript(model) {
    onBeforeApplyTranscript();
    timeline = model;
    following = true;
    notifyFollowingChange();
    refreshLayoutGaps();
    refreshEstimateMetrics();
    entryHeights = timeline.map((entry, index) => estimateEntryHeight(entry, index));
    entryMeasured = timeline.map(() => false);
    entryOffsets = new Array(timeline.length + 1);
    mountedByIndex.clear();
    disconnectEntryObservers();
    rebuildEntryOffsets(0);
    lastLayoutWidth = dom.fullPlayerTranscriptViewport.clientWidth;
    updateSpacerHeight();
    clearStatusMessage();

    const activeIndex = Math.max(0, findEntryIndex(timeline, getPlaybackTime()));
    activeEntryIndex = activeIndex;
    activeWordIndex = -1;
    renderVisibleEntriesNow(activeIndex);
    refreshPlaybackPinRange(activeIndex);
    maintainFollowScroll({ instant: true });
    resetHeightHydration(activeIndex);
    scheduleHeightHydration(activeIndex);

    setAvailability(AVAILABILITY.AVAILABLE);
    if (modeActive) {
      scheduleCenterRestore();
    } else {
      syncToPlaybackPosition({ forceCenter: false });
    }
    syncAnimationLoop();
  }

  function getListWidth() {
    const viewportWidth = dom.fullPlayerTranscriptViewport.clientWidth || 360;
    return Math.min(Math.max(viewportWidth - 4, 280), 760);
  }

  function ensureMeasureContainer() {
    if (measureContainer?.isConnected) {
      measureContainer.style.width = `${getListWidth()}px`;
      return measureContainer;
    }
    measureContainer = document.createElement("div");
    measureContainer.className = "full-player__transcript-list";
    measureContainer.setAttribute("aria-hidden", "true");
    Object.assign(measureContainer.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${getListWidth()}px`,
    });
    document.body.append(measureContainer);
    return measureContainer;
  }

  function refreshEstimateMetrics() {
    const container = ensureMeasureContainer();
    container.replaceChildren();

    const probe = document.createElement("button");
    probe.className = "transcript-passage";
    probe.type = "button";
    const scale = document.createElement("span");
    scale.className = "transcript-passage__scale";
    const sample = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (const ch of sample) {
      const word = document.createElement("span");
      word.className = "transcript-word";
      word.textContent = ch;
      scale.append(word, document.createTextNode(" "));
    }
    probe.append(scale);
    container.append(probe);

    const charWidth = Math.max(probe.offsetWidth / sample.length, 6);
    const lineHeight = Math.max(probe.offsetHeight, 24);
    probe.remove();

    estimateMetrics = {
      charWidth,
      lineHeight,
      width: getListWidth(),
      gap: layoutGaps.passage,
    };
  }

  function estimateEntryHeight(entry, index = -1) {
    if (entry.type === "silence") return estimateSilenceHeight();
    if (!estimateMetrics) refreshEstimateMetrics();

    const { charWidth, lineHeight, width, gap } = estimateMetrics;
    const charsPerLine = Math.max(1, Math.floor(width / charWidth));
    const lines = Math.max(1, Math.ceil((entry.body?.length || 0) / charsPerLine));
    return Math.ceil((lines * lineHeight + gap) * ESTIMATE_HEIGHT_MARGIN);
  }

  function measureEntryHeightDom(entry, index) {
    const previous = index > 0 ? timeline[index - 1] : null;
    const node = entry.type === "silence"
      ? createSilenceNode(entry, index)
      : createSegmentNode(entry, index, previous);
    const container = ensureMeasureContainer();
    node.element.style.position = "relative";
    node.element.style.transform = "none";
    node.element.style.left = "0";
    node.element.style.right = "auto";
    container.append(node.element);
    const height = node.element.offsetHeight;
    node.element.remove();
    return height;
  }

  function resetHeightHydration(startIndex = 0) {
    hydrateToken += 1;
    hydrateFrameActive = false;
    hydrateForward = Math.max(0, startIndex);
    hydrateBackward = Math.max(0, startIndex) - 1;
    hydratePhase = "forward";
  }

  function nextUnmeasuredHydrateIndex() {
    if (hydratePhase === "forward") {
      while (hydrateForward < timeline.length) {
        const index = hydrateForward;
        hydrateForward += 1;
        if (!entryMeasured[index]) return index;
      }
      hydratePhase = "backward";
    }

    while (hydrateBackward >= 0) {
      const index = hydrateBackward;
      hydrateBackward -= 1;
      if (!entryMeasured[index]) return index;
    }
    return -1;
  }

  function runHeightHydrationBatch() {
    const token = hydrateToken;
    if (!timeline.length) {
      hydrateFrameActive = false;
      return;
    }

    let changed = false;
    let finished = false;
    for (let count = 0; count < HYDRATE_BATCH_SIZE; count += 1) {
      const index = nextUnmeasuredHydrateIndex();
      if (index < 0) {
        finished = true;
        break;
      }
      entryHeights[index] = measureEntryHeightDom(timeline[index], index);
      entryMeasured[index] = true;
      changed = true;
    }

    if (changed) {
      const anchor = captureScrollAnchor();
      rebuildEntryOffsets(0);
      updateSpacerHeight();
      reconcileScrollAfterLayoutChange(anchor);
      repositionMountedEntries();
      scheduleRenderVisibleEntries();
    }

    if (finished || token !== hydrateToken) {
      hydrateFrameActive = false;
      return;
    }

    const scheduleNext = window.requestIdleCallback
      ? (callback) => window.requestIdleCallback(callback, { timeout: 120 })
      : (callback) => window.requestAnimationFrame(callback);

    scheduleNext(() => {
      if (token !== hydrateToken) {
        hydrateFrameActive = false;
        return;
      }
      runHeightHydrationBatch();
    });
  }

  function scheduleHeightHydration(priorityIndex = 0) {
    if (!timeline.length || availability !== AVAILABILITY.AVAILABLE) return;

    const priority = Math.max(0, priorityIndex);
    if (hydratePhase === "forward" && priority < hydrateForward) {
      hydrateForward = priority;
    }

    if (hydrateFrameActive) return;
    hydrateFrameActive = true;
    runHeightHydrationBatch();
  }

  function refreshPlaybackPinRange(nextIndex = activeEntryIndex) {
    if (!following || !modeActive || nextIndex < 0) {
      playbackPinStart = -1;
      playbackPinEnd = -1;
      return;
    }
    playbackPinStart = Math.max(0, nextIndex - FOLLOW_PIN_UP);
    playbackPinEnd = Math.min(timeline.length - 1, nextIndex + FOLLOW_PIN_DOWN);
  }

  function measureEntryHeightIfNeeded(index) {
    if (index < 0 || index >= timeline.length || entryMeasured[index]) return false;
    let measured = 0;
    const mounted = mountedByIndex.get(index);
    if (mounted) measured = mounted.element.offsetHeight;
    if (measured <= 0) measured = measureEntryHeightDom(timeline[index], index);
    if (measured <= 0) return false;
    entryHeights[index] = measured;
    entryMeasured[index] = true;
    rebuildEntryOffsets(index);
    return true;
  }

  function prepareFollowEntryTransition(nextIndex) {
    refreshPlaybackPinRange(nextIndex);
    const anchor = captureScrollAnchor();
    let remeasured = false;
    let minIndex = timeline.length;
    const mountEnd = Math.min(timeline.length - 1, nextIndex + FOLLOW_PREFETCH_AHEAD);
    for (let index = Math.max(0, nextIndex - 1); index <= mountEnd; index += 1) {
      if (measureEntryHeightIfNeeded(index)) {
        remeasured = true;
        minIndex = Math.min(minIndex, index);
      }
      if (!mountedByIndex.has(index)) {
        mountEntry(index);
      } else {
        positionMountedEntry(index);
      }
    }
    if (remeasured) {
      rebuildEntryOffsets(minIndex);
      updateSpacerHeight();
      restoreScrollAnchor(anchor);
      repositionMountedEntries();
    }
  }

  function commitMeasuredEntryHeight(index, measured) {
    const anchor = captureScrollAnchor();
    entryHeights[index] = measured;
    entryMeasured[index] = true;
    rebuildEntryOffsets(index);
    updateSpacerHeight();
    reconcileScrollAfterLayoutChange(anchor);
    repositionMountedEntries();
    scheduleRenderVisibleEntries();
    return true;
  }

  function flushDeferredHeightUpdates() {
    if (!deferredHeightUpdates.size) return;
    const anchor = captureScrollAnchor();
    let minIndex = timeline.length;
    for (const [index, measured] of deferredHeightUpdates) {
      entryHeights[index] = measured;
      entryMeasured[index] = true;
      minIndex = Math.min(minIndex, index);
    }
    deferredHeightUpdates.clear();
    rebuildEntryOffsets(minIndex);
    updateSpacerHeight();
    reconcileScrollAfterLayoutChange(anchor);
    repositionMountedEntries();
    scheduleRenderVisibleEntries();
  }

  function hydrateScrollAhead() {
    if (following || !timeline.length || availability !== AVAILABILITY.AVAILABLE) return;

    const viewport = dom.fullPlayerTranscriptViewport;
    const visibleIndex = findFirstVisibleIndex(viewport.scrollTop);
    if (visibleIndex < 0) return;

    const anchor = captureScrollAnchor();
    let remeasured = false;
    let minIndex = timeline.length;

    const measureIndex = (index) => {
      if (entryMeasured[index]) return;
      let measured = 0;
      const mounted = mountedByIndex.get(index);
      if (mounted) measured = mounted.element.offsetHeight;
      if (measured <= 0) measured = measureEntryHeightDom(timeline[index], index);
      if (measured <= 0) return;
      entryHeights[index] = measured;
      entryMeasured[index] = true;
      minIndex = Math.min(minIndex, index);
      remeasured = true;
    };

    if (scrollDirection >= 0) {
      const end = Math.min(timeline.length - 1, visibleIndex + SCROLL_AHEAD_HYDRATE);
      for (let index = visibleIndex; index <= end; index += 1) measureIndex(index);
    } else {
      const start = Math.max(0, visibleIndex - SCROLL_AHEAD_HYDRATE);
      for (let index = visibleIndex; index >= start; index -= 1) measureIndex(index);
    }

    if (!remeasured) return;
    rebuildEntryOffsets(minIndex);
    updateSpacerHeight();
    restoreScrollAnchor(anchor);
    repositionMountedEntries();
    scheduleRenderVisibleEntries();
  }

  function scheduleScrollAheadHydration() {
    if (following || scrollHydrateFrameId !== null) return;
    scrollHydrateFrameId = requestAnimationFrame(() => {
      scrollHydrateFrameId = null;
      hydrateScrollAhead();
      const visibleIndex = findFirstVisibleIndex(dom.fullPlayerTranscriptViewport.scrollTop);
      if (visibleIndex >= 0) scheduleHeightHydration(visibleIndex);
    });
  }

  function ensureFollowRangeMeasured(fromIndex) {
    if (fromIndex < 0 || fromIndex >= timeline.length) return;
    const viewport = dom.fullPlayerTranscriptViewport;
    if (viewport.classList.contains("is-auto-scrolling")) return;

    const end = Math.min(timeline.length - 1, fromIndex + FOLLOW_PIN_DOWN);
    const anchor = captureScrollAnchor();
    let remeasured = false;
    let minIndex = timeline.length;
    for (let index = fromIndex; index <= end; index += 1) {
      if (entryMeasured[index]) continue;
      const measured = measureEntryHeightDom(timeline[index], index);
      if (measured <= 0) continue;
      entryHeights[index] = measured;
      entryMeasured[index] = true;
      minIndex = Math.min(minIndex, index);
      remeasured = true;
    }
    if (!remeasured) return;
    rebuildEntryOffsets(minIndex);
    updateSpacerHeight();
    restoreScrollAnchor(anchor);
    repositionMountedEntries();
  }

  function syncActiveEntryPlaybackDom(currentTime, { forceWords = false } = {}) {
    if (activeEntryIndex < 0 || !timeline[activeEntryIndex]) return;
    refreshPlaybackPinRange(activeEntryIndex);
    if (!getMountedNode(activeEntryIndex)) mountEntry(activeEntryIndex);
    const node = getMountedNode(activeEntryIndex);
    if (!node) return;

    applyActiveClasses(node);
    const entry = timeline[activeEntryIndex];
    if (entry.type === "silence") {
      updateSilenceProgress(entry, node, currentTime);
      return;
    }
    if (forceWords) activeWordIndex = -1;
    updateActiveWords(entry, node, currentTime);
  }

  function onViewportScroll() {
    const viewport = dom.fullPlayerTranscriptViewport;
    const scrollTop = viewport.scrollTop;
    scrollDirection = scrollTop > lastScrollTop + 0.5
      ? 1
      : scrollTop < lastScrollTop - 0.5
        ? -1
        : scrollDirection;
    lastScrollTop = scrollTop;
    scheduleRenderVisibleEntries();

    if (following) {
      const visibleIndex = findFirstVisibleIndex(scrollTop);
      if (visibleIndex >= 0) scheduleHeightHydration(visibleIndex);
      return;
    }

    scheduleScrollAheadHydration();

    const visibleIndex = findFirstVisibleIndex(scrollTop);
    if (visibleIndex < 0) return;

    const nearScrollEnd = scrollTop + viewport.clientHeight > viewport.scrollHeight - (viewport.clientHeight * 1.5);
    if (nearScrollEnd && scrollDirection >= 0) {
      scheduleHeightHydration(Math.min(timeline.length - 1, visibleIndex + OVERSCAN_DETACHED_DOWN));
    }
  }

  function shouldMaintainFollowScroll() {
    return following && modeActive && activeEntryIndex >= 0;
  }

  function maintainFollowScroll({ instant = true } = {}) {
    if (!shouldMaintainFollowScroll()) return false;
    const node = getMountedNode(activeEntryIndex);
    if (node) return scrollToElement(node.element, { instant });
    return scrollToEntryIndex(activeEntryIndex, { instant, skipFineTune: instant });
  }

  function scheduleFollowScroll({ instant = true } = {}) {
    if (!shouldMaintainFollowScroll()) return;
    if (followScrollFrameId !== null) return;
    followScrollFrameId = requestAnimationFrame(() => {
      followScrollFrameId = null;
      maintainFollowScroll({ instant });
    });
  }

  function reconcileScrollAfterLayoutChange(anchor = null) {
    const viewport = dom.fullPlayerTranscriptViewport;
    const resolvedAnchor = anchor ?? captureScrollAnchor();
    if (shouldMaintainFollowScroll() && viewport.classList.contains("is-auto-scrolling")) {
      restoreScrollAnchor(resolvedAnchor);
      return;
    }
    if (shouldMaintainFollowScroll()) {
      scheduleFollowScroll({ instant: true });
      return;
    }
    restoreScrollAnchor(resolvedAnchor);
  }

  function applyMeasuredEntryHeight(index, measured) {
    if (measured <= 0) return false;
    if (entryMeasured[index] && Math.abs(entryHeights[index] - measured) < 1) return false;
    const viewport = dom.fullPlayerTranscriptViewport;
    if (viewport.classList.contains("is-auto-scrolling")) {
      deferredHeightUpdates.set(index, measured);
      return false;
    }
    return commitMeasuredEntryHeight(index, measured);
  }

  function estimateSilenceHeight() {
    return layoutGaps.silence || (PASSAGE_MARGIN + 28);
  }

  function getVignetteInset() {
    const raw = getComputedStyle(dom.fullPlayerTranscriptPanel).getPropertyValue("--transcript-vignette-size").trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 54;
  }

  function getVignetteBottomInset() {
    const raw = getComputedStyle(dom.fullPlayerTranscriptPanel).getPropertyValue("--transcript-vignette-bottom-size").trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : getVignetteInset();
  }

  function rebuildEntryOffsets(fromIndex = 0) {
    if (!timeline.length) {
      totalContentHeight = 0;
      entryOffsets = [];
      return;
    }
    if (!entryOffsets.length) entryOffsets = new Array(timeline.length + 1);
    const start = Math.max(0, fromIndex);
    if (start === 0) entryOffsets[0] = getVignetteInset();
    for (let index = start; index < timeline.length; index += 1) {
      entryOffsets[index + 1] = entryOffsets[index] + entryHeights[index];
    }
    totalContentHeight = entryOffsets[timeline.length];
  }

  function updateSpacerHeight() {
    const bottomInset = getVignetteBottomInset();
    dom.fullPlayerTranscriptSpacer.style.height = `${Math.max(0, totalContentHeight + bottomInset)}px`;
  }

  function markAllHeightsDirty() {
    for (let index = 0; index < timeline.length; index += 1) {
      entryMeasured[index] = false;
      entryHeights[index] = estimateEntryHeight(timeline[index], index);
    }
  }

  function captureScrollAnchor() {
    const viewport = dom.fullPlayerTranscriptViewport;
    const scrollTop = viewport.scrollTop;
    const index = findFirstVisibleIndex(scrollTop);
    if (index < 0) return { index: 0, offsetPx: 0 };
    return {
      index,
      offsetPx: scrollTop - entryOffsets[index],
    };
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor || anchor.index < 0) return;
    const viewport = dom.fullPlayerTranscriptViewport;
    viewport.scrollTop = Math.max(0, entryOffsets[anchor.index] + anchor.offsetPx);
  }

  function findFirstVisibleIndex(scrollTop) {
    if (!timeline.length) return -1;
    let low = 0;
    let high = timeline.length - 1;
    let result = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (entryOffsets[middle] <= scrollTop) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  function findVisibleRange(scrollTop, viewportHeight) {
    if (!timeline.length) return { start: 0, end: 0 };

    let overscanUp;
    let overscanDown;
    if (following) {
      overscanUp = FOLLOW_PIN_UP;
      overscanDown = FOLLOW_PIN_DOWN;
    } else {
      overscanUp = scrollDirection < 0 ? OVERSCAN_DETACHED_DOWN : OVERSCAN_DETACHED_UP;
      overscanDown = scrollDirection > 0 ? OVERSCAN_DETACHED_DOWN : OVERSCAN_DETACHED_UP;
    }

    let start = Math.max(0, findFirstVisibleIndex(scrollTop) - overscanUp);
    const endTop = scrollTop + viewportHeight;
    let end = start;
    while (end < timeline.length && entryOffsets[end] < endTop) {
      end += 1;
    }
    end = Math.min(timeline.length, end + overscanDown);
    if (playbackPinStart >= 0) {
      start = Math.min(start, playbackPinStart);
      end = Math.max(end, playbackPinEnd + 1);
    }
    if (forcedVisibleStart >= 0) {
      return {
        start: Math.min(start, forcedVisibleStart),
        end: Math.max(end, forcedVisibleEnd + 1),
      };
    }
    return { start, end };
  }

  function scheduleRenderVisibleEntries() {
    if (renderFrameId !== null) return;
    renderFrameId = requestAnimationFrame(() => {
      renderFrameId = null;
      renderVisibleEntriesNow();
    });
  }

  function renderVisibleEntriesNow(centerIndex = -1) {
    if (!timeline.length || availability !== AVAILABILITY.AVAILABLE) return;

    const viewport = dom.fullPlayerTranscriptViewport;
    let { start, end } = findVisibleRange(viewport.scrollTop, viewport.clientHeight);
    if (centerIndex >= 0) {
      start = Math.min(start, Math.max(0, centerIndex - OVERSCAN));
      end = Math.max(end, Math.min(timeline.length, centerIndex + OVERSCAN + 1));
    }

    const nextVisible = new Set();
    for (let index = start; index < end; index += 1) {
      nextVisible.add(index);
      if (!mountedByIndex.has(index)) {
        mountEntry(index);
      } else {
        positionMountedEntry(index);
      }
    }

    for (const [index, node] of mountedByIndex.entries()) {
      if (nextVisible.has(index)) continue;
      if (following && index === activeEntryIndex) continue;
      unmountEntry(index, node);
    }
    applySearchHighlightsToMounted();
    if (modeActive && activeEntryIndex >= 0) {
      const activeNode = getMountedNode(activeEntryIndex);
      const entry = timeline[activeEntryIndex];
      if (activeNode && entry?.type === "segment") {
        const time = getPlaybackTime();
        const wordIndex = findWordIndex(entry.words, time);
        const needsSpoken = wordIndex > 0
          && !activeNode.wordNodes[wordIndex - 1]?.classList.contains("is-spoken");
        const needsCurrent = wordIndex >= 0
          && !activeNode.wordNodes[wordIndex]?.classList.contains("is-current-word")
          && !activeNode.wordNodes[wordIndex]?.classList.contains("is-spoken");
        if (needsSpoken || needsCurrent) {
          syncActiveEntryPlaybackDom(time, { forceWords: true });
        }
      } else if (activeNode && entry?.type === "silence") {
        const dot = activeNode.dots[0];
        if (dot && !dot.style.getPropertyValue("--dot-fill")) {
          syncActiveEntryPlaybackDom(getPlaybackTime(), { forceWords: true });
        }
      }
    }
  }

  function mountEntry(index) {
    const entry = timeline[index];
    const previous = index > 0 ? timeline[index - 1] : null;
    const node = entry.type === "silence"
      ? createSilenceNode(entry, index)
      : createSegmentNode(entry, index, previous);
    node.element.style.transform = `translateY(${entryOffsets[index]}px)`;
    dom.fullPlayerTranscriptItems.append(node.element);
    mountedByIndex.set(index, node);

    const observer = new ResizeObserver(() => {
      const measured = node.element.offsetHeight;
      applyMeasuredEntryHeight(index, measured);
    });
    observer.observe(node.element);
    entryResizeObservers.set(index, observer);

    if (index === activeEntryIndex && modeActive) {
      syncActiveEntryPlaybackDom(getPlaybackTime(), { forceWords: true });
    }
    applySearchHighlightsToNode(node, index);
  }

  function unmountEntry(index, node = mountedByIndex.get(index)) {
    if (!node) return;
    const observer = entryResizeObservers.get(index);
    observer?.disconnect();
    entryResizeObservers.delete(index);
    node.element.remove();
    mountedByIndex.delete(index);
  }

  function positionMountedEntry(index) {
    const node = mountedByIndex.get(index);
    if (!node) return;
    node.element.style.transform = `translateY(${entryOffsets[index]}px)`;
  }

  function repositionMountedEntries() {
    for (const index of mountedByIndex.keys()) {
      positionMountedEntry(index);
    }
  }

  function disconnectEntryObservers() {
    for (const observer of entryResizeObservers.values()) {
      observer.disconnect();
    }
    entryResizeObservers.clear();
  }

  function ensureEntryMounted(index) {
    if (index < 0 || index >= timeline.length) return null;
    forcedVisibleStart = Math.max(0, index - OVERSCAN);
    forcedVisibleEnd = Math.min(timeline.length - 1, index + OVERSCAN);
    renderVisibleEntriesNow(index);
    forcedVisibleStart = -1;
    forcedVisibleEnd = -1;
    return mountedByIndex.get(index) || null;
  }

  function getMountedNode(index) {
    return mountedByIndex.get(index) || null;
  }

  function onViewportResize() {
    if (!timeline.length || availability !== AVAILABILITY.AVAILABLE) {
      scheduleRenderVisibleEntries();
      return;
    }

    const viewport = dom.fullPlayerTranscriptViewport;
    const nextWidth = viewport.clientWidth;
    if (Math.abs(nextWidth - lastLayoutWidth) < WIDTH_EPSILON) {
      scheduleRenderVisibleEntries();
      return;
    }
    lastLayoutWidth = nextWidth;
    refreshLayoutGaps();
    refreshEstimateMetrics();

    const anchor = captureScrollAnchor();
    const hadMeasured = entryMeasured.some(Boolean);
    if (hadMeasured) markAllHeightsDirty();
    else {
      for (let index = 0; index < timeline.length; index += 1) {
        entryHeights[index] = estimateEntryHeight(timeline[index], index);
      }
    }
    rebuildEntryOffsets(0);
    updateSpacerHeight();
    reconcileScrollAfterLayoutChange(anchor);
    repositionMountedEntries();
    scheduleRenderVisibleEntries();
    resetHeightHydration(Math.max(0, findFirstVisibleIndex(viewport.scrollTop)));
    scheduleHeightHydration(Math.max(0, findFirstVisibleIndex(viewport.scrollTop)));
  }

  function canScrollViewport() {
    return dom.fullPlayerTranscriptViewport.clientHeight > 0;
  }

  function syncToPlaybackPosition({ forceCenter = false, instant = false } = {}) {
    const time = getPlaybackTime();
    if (!timeline.length || !Number.isFinite(time)) return false;
    const shouldCenter = forceCenter || (pendingCenterRestore && modeActive);
    if (shouldCenter && !canScrollViewport()) {
      if (time > 0) pendingCenterRestore = true;
      return false;
    }
    const scrolled = update(time, {
      forceCenter: shouldCenter,
      instant: shouldCenter ? instant : false,
    });
    if (shouldCenter && modeActive && scrolled) {
      pendingCenterRestore = false;
      return true;
    }
    if (time > 0 && !modeActive) {
      pendingCenterRestore = true;
    }
    return !shouldCenter;
  }

  function scheduleCenterRestore() {
    if (!modeActive || !timeline.length) return;
    const attemptId = ++restoreAttemptId;
    let frames = 0;
    const maxFrames = 60;
    let transitionDone = false;

    const finishTransitionWait = () => {
      transitionDone = true;
    };

    dom.fullPlayer.addEventListener("transitionend", finishTransitionWait, { once: true });
    dom.fullPlayerTranscriptViewport.addEventListener("transitionend", finishTransitionWait, { once: true });
    window.setTimeout(finishTransitionWait, 480);

    function attempt() {
      if (attemptId !== restoreAttemptId || !modeActive) return;
      frames += 1;
      const restored = syncToPlaybackPosition({ forceCenter: true, instant: true });
      if (restored) {
        onCenterRestoreComplete();
        return;
      }
      if (frames < maxFrames || !transitionDone) {
        requestAnimationFrame(attempt);
      }
    }

    requestAnimationFrame(attempt);
  }

  function setUnavailable(message) {
    timeline = [];
    entryOffsets = [];
    entryHeights = [];
    entryMeasured = [];
    totalContentHeight = 0;
    mountedByIndex.clear();
    disconnectEntryObservers();
    renderMessage(message);
    setAvailability(AVAILABILITY.UNAVAILABLE);
    syncAnimationLoop();
  }

  function resetTranscript() {
    stopAnimationLoop();
    if (followScrollFrameId !== null) {
      cancelAnimationFrame(followScrollFrameId);
      followScrollFrameId = null;
    }
    timeline = [];
    entryOffsets = [];
    entryHeights = [];
    entryMeasured = [];
    totalContentHeight = 0;
    mountedByIndex.clear();
    disconnectEntryObservers();
    activeEntryIndex = -1;
    activeWordIndex = -1;
    following = true;
    pendingCenterRestore = false;
    forcedVisibleStart = -1;
    forcedVisibleEnd = -1;
    playbackPinStart = -1;
    playbackPinEnd = -1;
    deferredHeightUpdates.clear();
    if (scrollHydrateFrameId !== null) {
      cancelAnimationFrame(scrollHydrateFrameId);
      scrollHydrateFrameId = null;
    }
    releaseSearchScrollLock();
    resetHeightHydration(0);
    estimateMetrics = null;
    if (measureContainer) {
      measureContainer.remove();
      measureContainer = null;
    }
  }

  function clearVirtualDom() {
    mountedByIndex.clear();
    disconnectEntryObservers();
    dom.fullPlayerTranscriptItems.replaceChildren();
    dom.fullPlayerTranscriptSpacer.style.height = "0px";
  }

  function renderMessage(message) {
    clearVirtualDom();
    const status = document.createElement("p");
    status.className = "full-player__transcript-status";
    status.textContent = message;
    dom.fullPlayerTranscriptItems.append(status);
  }

  function clearStatusMessage() {
    const status = dom.fullPlayerTranscriptItems.querySelector(".full-player__transcript-status");
    status?.remove();
  }

  function createSegmentNode(entry, index, previousSegment) {
    const button = document.createElement("button");
    button.className = "transcript-passage";
    if (
      previousSegment?.type === "segment"
      && previousSegment?.speaker
      && entry.speaker
      && previousSegment.speaker !== entry.speaker
    ) {
      button.classList.add("transcript-passage--speaker-change");
    }
    button.type = "button";
    button.dataset.timelineIndex = String(index);
    button.setAttribute("aria-label", `Seek to ${formatTime(entry.startTime)}. ${entry.body}`);

    const scale = document.createElement("span");
    scale.className = "transcript-passage__scale";

    const wordNodes = entry.words.map((word, wordIndex) => {
      const span = document.createElement("span");
      span.className = "transcript-word";
      span.textContent = word.body;
      span.dataset.entryIndex = String(index);
      span.dataset.wordIndex = String(wordIndex);
      scale.append(span, document.createTextNode(" "));
      return span;
    });
    button.append(scale);

    if (isTranscriptDebugEnabled()) {
      const debug = document.createElement("span");
      debug.className = "transcript-passage__debug";
      debug.textContent = [
        `speaker=${entry.speaker || "unknown"}`,
        `turn=${entry.turnId ?? "unknown"}`,
        `${entry.startTime.toFixed(3)}\u2013${entry.endTime.toFixed(3)}`,
        `words=${entry.words.length}`,
      ].join("  ");
      button.append(debug);
    }

    button.addEventListener("click", () => {
      resumeFollowing();
      const seekTime = audioController.seek(entry.startTime);
      if (seekTime !== null) update(seekTime, { forceCenter: true, instant: false });
    });

    return { element: button, wordNodes, dots: [] };
  }

  function createSilenceNode(entry, index) {
    const row = document.createElement("div");
    row.className = "transcript-silence";
    row.dataset.timelineIndex = String(index);
    row.setAttribute("aria-label", `Silence until ${formatTime(entry.endTime)}`);

    const scale = document.createElement("span");
    scale.className = "transcript-silence__scale";

    const dots = Array.from({ length: 3 }, () => {
      const dot = document.createElement("span");
      dot.className = "transcript-silence__dot";
      dot.setAttribute("aria-hidden", "true");
      scale.append(dot);
      return dot;
    });
    row.append(scale);

    return { element: row, wordNodes: [], dots };
  }

  function setModeActive(active) {
    const nextActive = Boolean(active);
    if (modeActive === nextActive) return;
    modeActive = nextActive;
    if (!modeActive) {
      restoreAttemptId += 1;
    } else {
      resumeFollowing();
      void loadTranscript();
      scheduleCenterRestore();
    }
    syncAnimationLoop();
  }

  function setPlaybackActive(active) {
    const wasActive = playbackActive;
    playbackActive = Boolean(active);
    syncAnimationLoop();
    if (wasActive && !playbackActive && modeActive && activeEntryIndex >= 0) {
      update(getPlaybackTime(), { forceCenter: true, instant: false });
    }
  }

  function syncAnimationLoop() {
    if (modeActive && playbackActive && availability === AVAILABILITY.AVAILABLE) {
      if (frameId === null) frameId = requestAnimationFrame(tick);
      return;
    }
    stopAnimationLoop();
  }

  function tick() {
    frameId = null;
    update(audioController.getCurrentTime());
    syncAnimationLoop();
  }

  function stopAnimationLoop() {
    if (frameId === null) return;
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  function update(currentTime, { forceCenter = false, scrubbing = false, instant = false } = {}) {
    if (!timeline.length || !Number.isFinite(currentTime)) return false;
    const nextEntryIndex = findEntryIndex(timeline, currentTime);
    if (nextEntryIndex < 0) return false;

    const entryChanged = nextEntryIndex !== activeEntryIndex;

    if (!scrubbing && modeActive && !following) {
      const realignDetached = forceCenter || (playbackActive && entryChanged);
      if (realignDetached) {
        resumeFollowing({ scheduleScroll: false });
      }
    }

    const intentionalJump = scrubbing || forceCenter;
    const shouldFollow = following && !scrubbing;

    if (shouldFollow) {
      refreshPlaybackPinRange(nextEntryIndex);
      ensureFollowRangeMeasured(nextEntryIndex);
    }

    if (entryChanged && shouldFollow) {
      armSmoothScrollProtection();
    }

    if (entryChanged) {
      setActiveEntry(nextEntryIndex, { mountForDom: intentionalJump || shouldFollow });
    }

    if (entryChanged && shouldFollow) {
      prepareFollowEntryTransition(nextEntryIndex);
    } else if (shouldFollow && activeEntryIndex >= 0) {
      const activeEntry = timeline[activeEntryIndex];
      if (activeEntry && currentTime >= activeEntry.endTime - 5) {
        prepareFollowEntryTransition(activeEntryIndex + 1);
      }
    }

    const entry = timeline[nextEntryIndex];
    let node = getMountedNode(nextEntryIndex);

    if (intentionalJump) {
      node = ensureEntryMounted(nextEntryIndex);
    } else if (shouldFollow && entryChanged) {
      node = getMountedNode(nextEntryIndex);
    } else if (shouldFollow && !node && nextEntryIndex === activeEntryIndex) {
      syncActiveEntryPlaybackDom(currentTime, { forceWords: true });
      node = getMountedNode(nextEntryIndex);
    }

    if (entry.type === "silence") {
      if (node) updateSilenceProgress(entry, node, currentTime);
      if (!modeActive || !node) return false;
      if (scrubbing) return scrollToElement(node.element, { instant: true });
      if (forceCenter) return scrollToEntryIndex(nextEntryIndex, { instant });
      if (entryChanged && shouldFollow) return scrollToEntryIndex(nextEntryIndex, { instant: false });
      return false;
    }

    if (node) {
      updateActiveWords(entry, node, currentTime, { scrubbing });
    }

    if (!modeActive || !node) return false;
    if (scrubbing) {
      const wordIndex = findWordIndex(entry.words, currentTime);
      const target = wordIndex >= 0 ? node.wordNodes[wordIndex] : node.element;
      return scrollToElement(target, { instant: true });
    }
    if (forceCenter) {
      const target = getScrollTarget(entry, node, currentTime);
      return scrollToElement(target, { instant });
    }
    if (entryChanged && shouldFollow) return scrollToEntryIndex(nextEntryIndex, { instant: false });
    return false;
  }

  function applyActiveClasses(node) {
    node.element.classList.add("is-active");
    node.element.setAttribute("aria-current", "true");
  }

  function clearActiveClasses(node) {
    node.element.classList.remove("is-active");
    node.element.removeAttribute("aria-current");
    node.wordNodes.forEach((word) => word.classList.remove("is-spoken", "is-current-word"));
    node.dots.forEach((dot) => { dot.style.removeProperty("--dot-fill"); });
  }

  function setActiveEntry(nextIndex, { mountForDom = true } = {}) {
    const previousIndex = activeEntryIndex;
    if (previousIndex >= 0) {
      const previous = getMountedNode(previousIndex);
      if (previous) clearActiveClasses(previous);
    }

    activeEntryIndex = nextIndex;
    activeWordIndex = -1;
    refreshPlaybackPinRange(nextIndex);
    if (!mountForDom) return;

    const current = getMountedNode(nextIndex) || ensureEntryMounted(nextIndex);
    if (current) applyActiveClasses(current);
  }

  function updateActiveWords(entry, node, currentTime, { scrubbing = false } = {}) {
    const nextWordIndex = findWordIndex(entry.words, currentTime);

    if (scrubbing) {
      node.wordNodes.forEach((word, index) => {
        word.classList.toggle("is-spoken", nextWordIndex >= 0 && index < nextWordIndex);
        word.classList.remove("is-current-word");
      });
      if (nextWordIndex >= 0) {
        node.wordNodes[nextWordIndex]?.classList.add("is-current-word");
      }
      activeWordIndex = nextWordIndex;
      return;
    }

    if (nextWordIndex === activeWordIndex) return;

    if (nextWordIndex > activeWordIndex) {
      for (let index = activeWordIndex + 1; index <= nextWordIndex; index += 1) {
        node.wordNodes[index]?.classList.add("is-spoken");
      }
    } else {
      for (let index = activeWordIndex; index > nextWordIndex; index -= 1) {
        node.wordNodes[index]?.classList.remove("is-spoken", "is-current-word");
      }
    }

    node.wordNodes[activeWordIndex]?.classList.remove("is-current-word");
    activeWordIndex = nextWordIndex;
    if (activeWordIndex >= 0) {
      node.wordNodes[activeWordIndex]?.classList.add("is-current-word");
    }
  }

  function updateSilenceProgress(entry, node, currentTime) {
    const duration = entry.endTime - entry.startTime;
    const progress = duration > 0 ? clamp((currentTime - entry.startTime) / duration, 0, 1) : 1;
    node.dots.forEach((dot, index) => {
      const dotFill = clamp((progress * 3) - index, 0, 1);
      dot.style.setProperty("--dot-fill", dotFill.toFixed(3));
    });
  }

  function scrollToEntryIndex(index, { instant = false, skipFineTune = false } = {}) {
    if (index < 0 || index >= timeline.length) return false;
    const viewport = dom.fullPlayerTranscriptViewport;
    if (viewport.clientHeight <= 0) return false;

    ensureEntryMounted(index);
    const node = getMountedNode(index);
    if (!node) return false;

    if (skipFineTune) {
      const estimatedHeight = entryHeights[index] || estimateEntryHeight(timeline[index], index);
      const centerTop = entryOffsets[index]
        + (estimatedHeight / 2)
        - (viewport.clientHeight / 2);
      viewport.scrollTop = Math.max(
        0,
        Math.min(centerTop, Math.max(0, viewport.scrollHeight - viewport.clientHeight))
      );
      scheduleRenderVisibleEntries();
      return true;
    }

    return scrollToElement(node.element, { instant });
  }

  function releaseSearchScrollLock() {
    window.clearTimeout(searchScrollTimer);
    searchScrollTimer = null;
    forcedVisibleStart = -1;
    forcedVisibleEnd = -1;
  }

  function getElementScrollTop(element) {
    const viewport = dom.fullPlayerTranscriptViewport;
    if (!element || viewport.clientHeight <= 0) return 0;
    const scaleY = viewport.clientHeight > 0
      ? viewport.getBoundingClientRect().height / viewport.clientHeight
      : 1;
    return viewport.scrollTop
      + ((element.getBoundingClientRect().top - viewport.getBoundingClientRect().top) / scaleY);
  }

  function getOffsetTopWithin(element, scrollContainer) {
    let top = 0;
    let node = element;
    while (node && node !== scrollContainer) {
      top += node.offsetTop;
      node = node.offsetParent;
    }
    if (node !== scrollContainer) {
      const scaleY = scrollContainer.clientHeight > 0
        ? scrollContainer.getBoundingClientRect().height / scrollContainer.clientHeight
        : 1;
      return scrollContainer.scrollTop
        + ((element.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top) / scaleY);
    }
    return top;
  }

  function getScrollTarget(entry, node, currentTime) {
    if (entry.type === "silence") return node.element;
    const wordIndex = findWordIndex(entry.words, currentTime);
    return wordIndex >= 0 ? node.wordNodes[wordIndex] : node.element;
  }

  function getCenteredScrollTop(element, viewport) {
    const style = getComputedStyle(viewport);
    const padTop = Number.parseFloat(style.scrollPaddingTop) || getVignetteInset();
    const padBottom = Number.parseFloat(style.scrollPaddingBottom) || getVignetteBottomInset();
    const elementTop = getElementScrollTop(element);
    const readingHeight = Math.max(0, viewport.clientHeight - padTop - padBottom);
    return Math.max(0, elementTop - padTop - ((readingHeight - element.offsetHeight) / 2));
  }

  function isElementCentered(element, viewport) {
    if (!element || viewport.clientHeight <= 0) return false;
    return Math.abs(viewport.scrollTop - getCenteredScrollTop(element, viewport)) <= 2;
  }

  function armSmoothScrollProtection() {
    const viewport = dom.fullPlayerTranscriptViewport;
    window.clearTimeout(programmaticScrollTimer);
    viewport.classList.add("is-auto-scrolling");
  }

  function scrollToElement(element, { instant = false } = {}) {
    if (!element) return false;
    const viewport = dom.fullPlayerTranscriptViewport;
    if (viewport.clientHeight <= 0) return false;
    const top = getCenteredScrollTop(element, viewport);
    window.clearTimeout(programmaticScrollTimer);
    scheduleRenderVisibleEntries();
    if (instant) {
      viewport.classList.remove("is-auto-scrolling");
      viewport.scrollTop = top;
      scheduleRenderVisibleEntries();
      return isElementCentered(element, viewport);
    }
    viewport.classList.add("is-auto-scrolling");
    viewport.scrollTo({
      top,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    programmaticScrollTimer = window.setTimeout(() => {
      viewport.classList.remove("is-auto-scrolling");
      flushDeferredHeightUpdates();
      scheduleRenderVisibleEntries();
    }, 520);
    return true;
  }

  function setScrubbing(active) {
    if (active) suspendFollowing();
    else if (modeActive && playbackActive) resumeFollowing();
  }

  function notifyFollowingChange() {
    for (const listener of followingListeners) {
      listener(following);
    }
  }

  function isFollowing() {
    return following;
  }

  function onFollowingChange(listener) {
    followingListeners.add(listener);
    return () => followingListeners.delete(listener);
  }

  function suspendFollowing() {
    if (!modeActive || !following) return;
    following = false;
    refreshPlaybackPinRange();
    notifyFollowingChange();
  }

  function resumeFollowing({ scheduleScroll = true } = {}) {
    if (following) return;
    following = true;
    notifyFollowingChange();
    refreshPlaybackPinRange(activeEntryIndex);
    scheduleRenderVisibleEntries();
    if (scheduleScroll && modeActive && playbackActive && activeEntryIndex >= 0) {
      syncActiveEntryPlaybackDom(getPlaybackTime(), { forceWords: true });
      scheduleFollowScroll({ instant: false });
    }
  }

  function clearSearchHighlightsOnNode(node, entryIndex) {
    const entry = timeline[entryIndex];
    node.wordNodes.forEach((word, wordIndex) => {
      word.classList.remove("is-search-match", "is-search-active");
      word.textContent = entry?.words?.[wordIndex]?.body ?? word.textContent;
    });
  }

  function renderWordSearchHighlight(wordSpan, bodyText, highlights) {
    wordSpan.classList.remove("is-search-match", "is-search-active");

    if (!highlights.length) {
      wordSpan.textContent = bodyText;
      return;
    }

    const wholeWordHighlights = highlights.filter((highlight) => highlight.wholeWord);
    if (wholeWordHighlights.length) {
      wordSpan.textContent = bodyText;
      wordSpan.classList.add("is-search-match");
      if (wholeWordHighlights.some((highlight) => highlight.isActive)) {
        wordSpan.classList.add("is-search-active");
      }
      return;
    }

    const ranges = highlights
      .map((highlight) => ({
        start: highlight.charStart,
        end: highlight.charStart + highlight.charLength,
        isActive: highlight.isActive,
      }))
      .sort((left, right) => left.start - right.start);

    wordSpan.replaceChildren();
    let cursor = 0;
    for (const range of ranges) {
      if (cursor < range.start) {
        wordSpan.append(document.createTextNode(bodyText.slice(cursor, range.start)));
      }
      const mark = document.createElement("span");
      mark.className = "transcript-word__search is-search-match";
      if (range.isActive) mark.classList.add("is-search-active");
      mark.textContent = bodyText.slice(range.start, range.end);
      wordSpan.append(mark);
      cursor = range.end;
    }
    if (cursor < bodyText.length) {
      wordSpan.append(document.createTextNode(bodyText.slice(cursor)));
    }
  }

  function applySearchHighlightsToNode(node, entryIndex) {
    const entry = timeline[entryIndex];
    if (!entry || entry.type !== "segment") return;

    node.wordNodes.forEach((wordSpan, wordIndex) => {
      const bodyText = entry.words[wordIndex]?.body ?? "";

      if (!searchMatches.length) {
        renderWordSearchHighlight(wordSpan, bodyText, []);
        return;
      }

      const highlights = [];
      searchMatches.forEach((match, matchIndex) => {
        if (match.entryIndex !== entryIndex) return;
        if (wordIndex < match.wordIndex || wordIndex >= match.wordIndex + match.wordCount) return;

        const isActive = matchIndex === searchActiveMatchIndex;
        if (match.wordCount === 1 && match.charStart != null) {
          highlights.push({
            wholeWord: false,
            charStart: match.charStart,
            charLength: match.charLength,
            isActive,
          });
        } else {
          highlights.push({ wholeWord: true, isActive });
        }
      });

      renderWordSearchHighlight(wordSpan, bodyText, highlights);
    });
  }

  function applySearchHighlightsToMounted() {
    if (!searchMatches.length) return;
    for (const [index, node] of mountedByIndex.entries()) {
      applySearchHighlightsToNode(node, index);
    }
  }

  function applySearchHighlights(matches, activeMatchIndex) {
    searchMatches = matches;
    searchActiveMatchIndex = activeMatchIndex;
    if (!searchMatches.length) {
      for (const [index, node] of mountedByIndex.entries()) {
        clearSearchHighlightsOnNode(node, index);
      }
      return;
    }
    applySearchHighlightsToMounted();
  }

  function clearSearchHighlights() {
    searchMatches = [];
    searchActiveMatchIndex = -1;
    releaseSearchScrollLock();
    for (const [index, node] of mountedByIndex.entries()) {
      clearSearchHighlightsOnNode(node, index);
    }
    scheduleRenderVisibleEntries();
  }

  function getSearchMatchElement(node, match) {
    const wordSpan = node.wordNodes[match.wordIndex];
    if (!wordSpan) return node.element;
    if (match.charStart != null) {
      const activeMark = wordSpan.querySelector(".transcript-word__search.is-search-active");
      if (activeMark) return activeMark;
    }
    return wordSpan;
  }

  async function scrollToSearchMatch(match, { instant = false } = {}) {
    if (!match || match.entryIndex < 0 || match.entryIndex >= timeline.length) return false;

    const entryIndex = match.entryIndex;
    releaseSearchScrollLock();
    forcedVisibleStart = Math.max(0, entryIndex - OVERSCAN);
    forcedVisibleEnd = Math.min(timeline.length - 1, entryIndex + OVERSCAN);
    renderVisibleEntriesNow(entryIndex);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    let node = getMountedNode(entryIndex);
    if (!node) {
      releaseSearchScrollLock();
      scheduleRenderVisibleEntries();
      return false;
    }

    applySearchHighlightsToMounted();
    const target = getSearchMatchElement(node, match);
    if (!target) {
      releaseSearchScrollLock();
      scheduleRenderVisibleEntries();
      return false;
    }

    const useInstant = instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrolled = scrollToElement(target, { instant: useInstant });

    const finishSearchScroll = () => {
      applySearchHighlightsToMounted();
      releaseSearchScrollLock();
      scheduleRenderVisibleEntries();
    };

    if (useInstant) {
      finishSearchScroll();
    } else {
      searchScrollTimer = window.setTimeout(finishSearchScroll, 540);
    }

    return scrolled;
  }

  function isModeActive() {
    return modeActive;
  }

  function getTimeline() {
    return timeline;
  }

  function setBeforeApplyTranscript(callback) {
    onBeforeApplyTranscript = typeof callback === "function" ? callback : () => {};
  }

  function onViewportTouchStart(event) {
    if (event.target.closest(".transcript-passage")) {
      passageTouchStartY = event.touches[0]?.clientY ?? null;
      return;
    }
    passageTouchStartY = null;
    suspendFollowing();
  }

  function onViewportTouchMove(event) {
    if (passageTouchStartY === null || !following) return;
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    if (Math.abs(y - passageTouchStartY) >= PASSAGE_TOUCH_SCROLL_THRESHOLD) {
      passageTouchStartY = null;
      suspendFollowing();
    }
  }

  function onViewportTouchEnd() {
    passageTouchStartY = null;
  }

  dom.fullPlayerTranscriptViewport.addEventListener("scroll", onViewportScroll, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("wheel", suspendFollowing, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchstart", onViewportTouchStart, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchmove", onViewportTouchMove, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchend", onViewportTouchEnd, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchcancel", onViewportTouchEnd, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".transcript-passage")) suspendFollowing();
  });

  new ResizeObserver(() => {
    onViewportResize();
  }).observe(dom.fullPlayerTranscriptViewport);

  return {
    getAvailability,
    setModeActive,
    setPlaybackActive,
    setScrubbing,
    setSelectedEpisode,
    loadTranscript,
    syncToPlaybackPosition,
    scheduleCenterRestore,
    update,
    isFollowing,
    onFollowingChange,
    isModeActive,
    applySearchHighlights,
    clearSearchHighlights,
    scrollToSearchMatch,
    setBeforeApplyTranscript,
    getTimeline,
  };
}

export function buildTranscriptTimeline(payload) {
  if (payload?.format !== "mssp-transcript" || !Array.isArray(payload.segments)) return [];

  const normalizedSegments = payload.segments.map(normalizeSegment);
  if (normalizedSegments.some((segment) => !segment)) return [];
  const segments = normalizedSegments.sort((a, b) => a.startTime - b.startTime);
  const timeline = [];
  const durationSeconds = getEpisodeDurationSeconds(payload);

  const first = segments[0];
  if (first) {
    pushSilenceEntry(timeline, 0, first.startTime, { leading: true });
  }

  segments.forEach((segment, index) => {
    timeline.push(segment);
    const next = segments[index + 1];
    if (!next) return;
    pushSilenceEntry(timeline, segment.endTime, next.startTime);
  });

  const last = segments[segments.length - 1];
  if (last && durationSeconds !== null) {
    pushSilenceEntry(timeline, last.endTime, durationSeconds);
  }

  return timeline;
}

function pushSilenceEntry(timeline, gapStart, gapEnd, { leading = false } = {}) {
  const gap = gapEnd - gapStart;
  if (gap < SILENCE_THRESHOLD_SECONDS) return;
  timeline.push({
    type: "silence",
    startTime: leading
      ? gapStart
      : Math.min(gapStart + SPOKEN_HOLD_SECONDS, gapEnd),
    endTime: gapEnd,
  });
}

function getEpisodeDurationSeconds(payload) {
  const candidates = [
    payload?.diagnostics?.durationSeconds,
    payload?.metadata?.durationSeconds,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeSegment(segment) {
  const startTime = Number(segment?.startTime);
  const endTime = Number(segment?.endTime);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  if (!Array.isArray(segment.words) || !segment.words.length) return null;

  const words = segment.words.map((word) => ({
    body: String(word?.body || "").trim(),
    startTime: Number(word?.startTime),
    endTime: Number(word?.endTime),
    speaker: word?.speaker || null,
  })).filter((word) => (
    word.body
    && Number.isFinite(word.startTime)
    && Number.isFinite(word.endTime)
    && word.endTime >= word.startTime
  ));
  if (!words.length || words.length !== segment.words.length) return null;

  return {
    type: "segment",
    startTime,
    endTime,
    body: words.map((word) => word.body).join(" "),
    speaker: segment.speaker || words[0]?.speaker || null,
    turnId: segment.turnId ?? null,
    words,
  };
}

function isTranscriptDebugEnabled() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("transcriptDebug") === "1";
}

function findEntryIndex(entries, time) {
  let low = 0;
  let high = entries.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle].startTime <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function findWordIndex(words, time) {
  let low = 0;
  let high = words.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].startTime <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
