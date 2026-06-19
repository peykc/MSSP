const SILENCE_THRESHOLD_SECONDS = 3;
const AVAILABILITY = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

export function createTranscriptView({ dom, audioController, onAvailabilityChange = () => {} }) {
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
    update(audioController.getCurrentTime(), { forceCenter: true });
    syncAnimationLoop();
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
    dom.fullPlayerTranscriptReturn.hidden = true;
  }

  function renderMessage(message) {
    const status = document.createElement("p");
    status.className = "full-player__transcript-status";
    status.textContent = message;
    dom.fullPlayerTranscriptList.replaceChildren(status);
    entryNodes = [];
  }

  function renderTimeline() {
    entryNodes = timeline.map((entry, index) => {
      if (entry.type === "silence") return createSilenceNode(entry, index);
      return createSegmentNode(entry, index);
    });
    dom.fullPlayerTranscriptList.replaceChildren(...entryNodes.map((item) => item.element));
  }

  function createSegmentNode(entry, index) {
    const button = document.createElement("button");
    button.className = "transcript-passage";
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

    button.addEventListener("click", () => {
      following = true;
      updateReturnControl();
      const seekTime = audioController.seek(entry.startTime);
      if (seekTime !== null) update(seekTime, { forceCenter: true });
    });

    return { element: button, wordNodes, dotFills: [] };
  }

  function createSilenceNode(entry, index) {
    const row = document.createElement("div");
    row.className = "transcript-silence";
    row.dataset.timelineIndex = String(index);
    row.setAttribute("aria-label", `Silence until ${formatTime(entry.endTime)}`);

    const dotFills = Array.from({ length: 3 }, () => {
      const dot = document.createElement("span");
      dot.className = "transcript-silence__dot";
      dot.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "transcript-silence__fill";
      dot.append(fill);
      row.append(dot);
      return fill;
    });

    return { element: row, wordNodes: [], dotFills };
  }

  function setModeActive(active) {
    const nextActive = Boolean(active);
    if (modeActive === nextActive) return;
    modeActive = nextActive;
    if (modeActive) {
      following = true;
      updateReturnControl();
      update(audioController.getCurrentTime(), { forceCenter: true });
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

  function update(currentTime, { forceCenter = false } = {}) {
    if (!timeline.length || !Number.isFinite(currentTime)) return;
    const nextEntryIndex = findEntryIndex(timeline, currentTime);
    if (nextEntryIndex < 0) return;

    if (nextEntryIndex !== activeEntryIndex) {
      setActiveEntry(nextEntryIndex);
      if (modeActive && (following || forceCenter)) centerEntry(nextEntryIndex);
    } else if (forceCenter && modeActive) {
      centerEntry(nextEntryIndex);
    }

    const entry = timeline[nextEntryIndex];
    if (entry.type === "silence") {
      updateSilenceProgress(entry, entryNodes[nextEntryIndex], currentTime);
      return;
    }

    updateActiveWords(entry, entryNodes[nextEntryIndex], currentTime);
  }

  function setActiveEntry(nextIndex) {
    if (activeEntryIndex >= 0) {
      const previous = entryNodes[activeEntryIndex];
      previous?.element.classList.remove("is-active");
      previous?.element.removeAttribute("aria-current");
      previous?.wordNodes.forEach((word) => word.classList.remove("is-spoken", "is-current-word"));
      previous?.dotFills.forEach((fill) => { fill.style.transform = "scaleX(0)"; });
    }

    activeEntryIndex = nextIndex;
    activeWordIndex = -1;
    const current = entryNodes[nextIndex];
    current?.element.classList.add("is-active");
    current?.element.setAttribute("aria-current", "true");
  }

  function updateActiveWords(entry, node, currentTime) {
    const nextWordIndex = findWordIndex(entry.words, currentTime);
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
    node.wordNodes[activeWordIndex]?.classList.add("is-current-word");
  }

  function updateSilenceProgress(entry, node, currentTime) {
    const duration = entry.endTime - entry.startTime;
    const progress = duration > 0 ? clamp((currentTime - entry.startTime) / duration, 0, 1) : 1;
    node.dotFills.forEach((fill, index) => {
      const dotProgress = clamp((progress * 3) - index, 0, 1);
      fill.style.transform = `scaleX(${dotProgress})`;
    });
  }

  function centerEntry(index) {
    const element = entryNodes[index]?.element;
    if (!element) return;
    const viewport = dom.fullPlayerTranscriptViewport;
    const top = element.offsetTop - ((viewport.clientHeight - element.offsetHeight) / 2);
    window.clearTimeout(programmaticScrollTimer);
    viewport.classList.add("is-auto-scrolling");
    viewport.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    programmaticScrollTimer = window.setTimeout(() => {
      viewport.classList.remove("is-auto-scrolling");
    }, 360);
  }

  function suspendFollowing() {
    if (!modeActive || !following) return;
    following = false;
    updateReturnControl();
  }

  function updateReturnControl() {
    dom.fullPlayerTranscriptReturn.hidden = !modeActive || following;
  }

  dom.fullPlayerTranscriptViewport.addEventListener("wheel", suspendFollowing, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("touchstart", suspendFollowing, { passive: true });
  dom.fullPlayerTranscriptViewport.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".transcript-passage")) suspendFollowing();
  });
  dom.fullPlayerTranscriptReturn.addEventListener("click", () => {
    following = true;
    updateReturnControl();
    update(audioController.getCurrentTime(), { forceCenter: true });
  });

  return {
    getAvailability,
    setModeActive,
    setPlaybackActive,
    syncEpisode,
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
        startTime: segment.endTime,
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
    words,
  };
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
