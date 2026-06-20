const SILENCE_THRESHOLD_SECONDS = 3;
const SPOKEN_HOLD_SECONDS = 0.5;
const AVAILABILITY = Object.freeze({
  IDLE: "idle",
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
}) {
  const cache = new Map();
  let selectedEpisodeKey = "";
  let loadToken = 0;
  let availability = AVAILABILITY.IDLE;
  let timeline = [];
  let entryNodes = [];
  let activeEntryIndex = -1;
  let activeWordIndex = -1;
  let modeActive = false;
  let playbackActive = false;
  let following = true;
  let pendingCenterRestore = false;
  let restoreAttemptId = 0;
  let frameId = null;
  let programmaticScrollTimer = null;

  function getAvailability() {
    return availability;
  }

  function setAvailability(nextAvailability) {
    if (availability === nextAvailability) return;
    availability = nextAvailability;
    onAvailabilityChange(nextAvailability, selectedEpisodeKey);
  }

  async function syncEpisode(episode) {
    const episodeKey = episode?.episodeKey || "";
    if (episodeKey === selectedEpisodeKey) return;

    selectedEpisodeKey = episodeKey;
    const token = ++loadToken;
    resetTranscript();

    if (!episodeKey) {
      setAvailability(AVAILABILITY.IDLE);
      renderMessage("No transcript selected.");
      return;
    }

    setAvailability(AVAILABILITY.LOADING);
    renderMessage("Loading transcript…");

    const cached = cache.get(episodeKey);
    if (cached) {
      applyTranscript(cached);
      return;
    }

    try {
      const response = await fetch(`./data/transcripts/${encodeURIComponent(episodeKey)}.json`);
      if (token !== loadToken || episodeKey !== selectedEpisodeKey) return;
      if (!response.ok) {
        setUnavailable(response.status === 404 ? "Transcript unavailable." : "Could not load transcript.");
        return;
      }

      const payload = await response.json();
      const model = buildTranscriptTimeline(payload);
      if (!model.length) throw new Error("Transcript contains no timed words.");
      if (token !== loadToken || episodeKey !== selectedEpisodeKey) return;

      cache.set(episodeKey, model);
      applyTranscript(model);
    } catch (error) {
      if (token !== loadToken || episodeKey !== selectedEpisodeKey) return;
      console.warn("[MSSP] Transcript unavailable.", error);
      setUnavailable("Transcript unavailable.");
    }
  }

  function applyTranscript(model) {
    timeline = model;
    following = true;
    renderTimeline();
    setAvailability(AVAILABILITY.AVAILABLE);
    if (modeActive) {
      scheduleCenterRestore();
    } else {
      syncToPlaybackPosition({ forceCenter: false });
    }
    syncAnimationLoop();
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
      instant: shouldCenter ? instant || forceCenter : false,
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
    renderMessage(message);
    setAvailability(AVAILABILITY.UNAVAILABLE);
    syncAnimationLoop();
  }

  function resetTranscript() {
    stopAnimationLoop();
    timeline = [];
    entryNodes = [];
    activeEntryIndex = -1;
    activeWordIndex = -1;
    following = true;
    pendingCenterRestore = false;
  }

  function renderMessage(message) {
    const status = document.createElement("p");
    status.className = "full-player__transcript-status";
    status.textContent = message;
    dom.fullPlayerTranscriptList.replaceChildren(status);
    entryNodes = [];
  }

  function renderTimeline() {
    let previousSegment = null;
    entryNodes = timeline.map((entry, index) => {
      if (entry.type === "silence") return createSilenceNode(entry, index);
      const node = createSegmentNode(entry, index, previousSegment);
      previousSegment = entry;
      return node;
    });
    dom.fullPlayerTranscriptList.replaceChildren(...entryNodes.map((item) => item.element));
  }

  function createSegmentNode(entry, index, previousSegment) {
    const button = document.createElement("button");
    button.className = "transcript-passage";
    if (
      previousSegment?.speaker
      && entry.speaker
      && previousSegment.speaker !== entry.speaker
    ) {
      button.classList.add("transcript-passage--speaker-change");
    }
    button.type = "button";
    button.dataset.timelineIndex = String(index);
    button.setAttribute("aria-label", `Seek to ${formatTime(entry.startTime)}. ${entry.body}`);

    const wordNodes = entry.words.map((word) => {
      const span = document.createElement("span");
      span.className = "transcript-word";
      span.textContent = word.body;
      button.append(span, document.createTextNode(" "));
      return span;
    });

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
      if (seekTime !== null) update(seekTime, { forceCenter: true });
    });

    return { element: button, wordNodes, dots: [] };
  }

  function createSilenceNode(entry, index) {
    const row = document.createElement("div");
    row.className = "transcript-silence";
    row.dataset.timelineIndex = String(index);
    row.setAttribute("aria-label", `Silence until ${formatTime(entry.endTime)}`);

    const dots = Array.from({ length: 3 }, () => {
      const dot = document.createElement("span");
      dot.className = "transcript-silence__dot";
      dot.setAttribute("aria-hidden", "true");
      row.append(dot);
      return dot;
    });

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
      scheduleCenterRestore();
    }
    syncAnimationLoop();
  }

  function setPlaybackActive(active) {
    playbackActive = Boolean(active);
    syncAnimationLoop();
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
    if (entryChanged) {
      if (modeActive && playbackActive && !following && !scrubbing) resumeFollowing();
      setActiveEntry(nextEntryIndex);
    }

    const entry = timeline[nextEntryIndex];
    const node = entryNodes[nextEntryIndex];
    if (entry.type === "silence") {
      updateSilenceProgress(entry, node, currentTime);
      if (!modeActive) return false;
      if (scrubbing) return scrollToElement(node.element, { instant: true });
      if (forceCenter) return scrollToElement(node.element, { instant: true });
      if (entryChanged && following) return scrollToElement(node.element, { instant: false });
      return false;
    }

    updateActiveWords(entry, node, currentTime, { scrubbing });
    if (!modeActive) return false;
    if (scrubbing) {
      const wordIndex = findWordIndex(entry.words, currentTime);
      const target = wordIndex >= 0 ? node.wordNodes[wordIndex] : node.element;
      return scrollToElement(target, { instant: true });
    }
    if (forceCenter) {
      const target = getScrollTarget(entry, node, currentTime);
      return scrollToElement(target, { instant: instant || true });
    }
    if (entryChanged && following) return scrollToElement(node.element, { instant: false });
    return false;
  }

  function setActiveEntry(nextIndex) {
    if (activeEntryIndex >= 0) {
      const previous = entryNodes[activeEntryIndex];
      previous?.element.classList.remove("is-active");
      previous?.element.removeAttribute("aria-current");
      previous?.wordNodes.forEach((word) => word.classList.remove("is-spoken", "is-current-word"));
      previous?.dots.forEach((dot) => { dot.style.removeProperty("--dot-fill"); });
    }

    activeEntryIndex = nextIndex;
    activeWordIndex = -1;
    const current = entryNodes[nextIndex];
    current?.element.classList.add("is-active");
    current?.element.setAttribute("aria-current", "true");
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
    const padTop = Number.parseFloat(style.scrollPaddingTop) || 0;
    const padBottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
    const elementTop = getOffsetTopWithin(element, viewport);
    const readingHeight = Math.max(0, viewport.clientHeight - padTop - padBottom);
    return Math.max(0, elementTop - padTop - ((readingHeight - element.offsetHeight) / 2));
  }

  function isElementCentered(element, viewport) {
    if (!element || viewport.clientHeight <= 0) return false;
    return Math.abs(viewport.scrollTop - getCenteredScrollTop(element, viewport)) <= 2;
  }

  function scrollToElement(element, { instant = false } = {}) {
    if (!element) return false;
    const viewport = dom.fullPlayerTranscriptViewport;
    if (viewport.clientHeight <= 0) return false;
    const top = getCenteredScrollTop(element, viewport);
    window.clearTimeout(programmaticScrollTimer);
    viewport.classList.remove("is-auto-scrolling");
    if (instant) {
      viewport.scrollTop = top;
      return isElementCentered(element, viewport);
    }
    viewport.classList.add("is-auto-scrolling");
    viewport.scrollTo({
      top,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    programmaticScrollTimer = window.setTimeout(() => {
      viewport.classList.remove("is-auto-scrolling");
    }, 360);
    return true;
  }

  function setScrubbing(active) {
    if (active) suspendFollowing();
    else if (modeActive && playbackActive) resumeFollowing();
  }

  function suspendFollowing() {
    if (!modeActive || !following) return;
    following = false;
  }

  function resumeFollowing() {
    if (following) return;
    following = true;
  }

  dom.fullPlayerTranscriptViewport.addEventListener("wheel", suspendFollowing, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchstart", suspendFollowing, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".transcript-passage")) suspendFollowing();
  });

  return {
    getAvailability,
    setModeActive,
    setPlaybackActive,
    setScrubbing,
    syncEpisode,
    syncToPlaybackPosition,
    scheduleCenterRestore,
    update,
  };
}

export function buildTranscriptTimeline(payload) {
  if (payload?.format !== "mssp-transcript" || !Array.isArray(payload.segments)) return [];

  const normalizedSegments = payload.segments.map(normalizeSegment);
  if (normalizedSegments.some((segment) => !segment)) return [];
  const segments = normalizedSegments.sort((a, b) => a.startTime - b.startTime);
  const timeline = [];
  segments.forEach((segment, index) => {
    timeline.push(segment);
    const next = segments[index + 1];
    if (!next) return;
    const gap = next.startTime - segment.endTime;
    if (gap >= SILENCE_THRESHOLD_SECONDS) {
      timeline.push({
        type: "silence",
        startTime: Math.min(segment.endTime + SPOKEN_HOLD_SECONDS, next.startTime),
        endTime: next.startTime,
      });
    }
  });
  return timeline;
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
