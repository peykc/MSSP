const SEARCH_DEBOUNCE_MS = 150;

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapNormalizedRangeToOriginal(wordBody, normStart, normLen) {
  const normWord = normalizeSearchText(wordBody);
  if (normWord.length === wordBody.length) {
    return { charStart: normStart, charLength: normLen };
  }

  let normPos = 0;
  let origStart = null;
  let origEnd = null;
  const lower = wordBody.toLowerCase();
  for (let i = 0; i < wordBody.length; i += 1) {
    const ch = lower[i];
    if (/[''']/.test(ch)) continue;
    if (/[^\w\s]/.test(ch)) continue;
    if (normPos === normStart) origStart = i;
    if (normPos === normStart + normLen - 1) {
      origEnd = i;
      break;
    }
    normPos += 1;
  }

  if (origStart == null || origEnd == null) {
    return { charStart: 0, charLength: wordBody.length };
  }
  return { charStart: origStart, charLength: origEnd - origStart + 1 };
}

function findWordSubstringRanges(wordBody, normalizedToken) {
  const normWord = normalizeSearchText(wordBody);
  const ranges = [];
  let from = 0;
  while (from <= normWord.length - normalizedToken.length) {
    const idx = normWord.indexOf(normalizedToken, from);
    if (idx === -1) break;
    ranges.push(mapNormalizedRangeToOriginal(wordBody, idx, normalizedToken.length));
    from = idx + 1;
  }
  return ranges;
}

export { findWordSubstringRanges };

export function buildSearchIndex(timeline, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const matches = [];

  for (let entryIndex = 0; entryIndex < timeline.length; entryIndex += 1) {
    const entry = timeline[entryIndex];
    if (entry.type !== "segment") continue;

    const normalizedWords = entry.words.map((word) => normalizeSearchText(word.body));

    if (queryTokens.length === 1) {
      const token = queryTokens[0];
      for (let wordIndex = 0; wordIndex < entry.words.length; wordIndex += 1) {
        if (!normalizedWords[wordIndex].includes(token)) continue;
        const ranges = findWordSubstringRanges(entry.words[wordIndex].body, token);
        for (const range of ranges) {
          matches.push({ entryIndex, wordIndex, wordCount: 1, ...range });
        }
      }
      continue;
    }

    const joinedQuery = queryTokens.join(" ");
    for (let wordIndex = 0; wordIndex < normalizedWords.length; wordIndex += 1) {
      if (!normalizedWords[wordIndex].includes(joinedQuery)) continue;
      const ranges = findWordSubstringRanges(entry.words[wordIndex].body, joinedQuery);
      for (const range of ranges) {
        matches.push({ entryIndex, wordIndex, wordCount: 1, ...range });
      }
    }

    for (let start = 0; start <= normalizedWords.length - queryTokens.length; start += 1) {
      let matched = true;
      for (let tokenIndex = 0; tokenIndex < queryTokens.length; tokenIndex += 1) {
        if (!normalizedWords[start + tokenIndex].includes(queryTokens[tokenIndex])) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      matches.push({
        entryIndex,
        wordIndex: start,
        wordCount: queryTokens.length,
        tokenHighlights: queryTokens.map((token, tokenIndex) => {
          const ranges = findWordSubstringRanges(entry.words[start + tokenIndex].body, token);
          return ranges[0] || null;
        }),
      });
    }
  }

  return matches;
}

export function createTranscriptSearch({
  dom,
  transcriptView,
  getIsPlayerOpen = () => true,
}) {
  let timeline = [];
  let matches = [];
  let activeMatchIndex = -1;
  let searchVersion = 0;
  let debounceTimer = null;
  let isOpen = false;

  function resetForEpisode() {
    searchVersion += 1;
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    timeline = [];
    matches = [];
    activeMatchIndex = -1;
    isOpen = false;
    dom.fullPlayerTranscriptSearchInput.value = "";
    dom.fullPlayerTranscriptSearch.classList.remove("is-open");
    dom.fullPlayerTranscriptSearchBar.hidden = true;
    dom.fullPlayerTranscriptSearchTrigger.hidden = false;
    transcriptView.clearSearchHighlights();
    updateCounter();
    updateNavButtons();
    syncRootVisibility();
  }

  function setTimeline(nextTimeline) {
    timeline = Array.isArray(nextTimeline) ? nextTimeline : [];
  }

  function syncRootVisibility() {
    const available = !transcriptView.isFollowing()
      && transcriptView.isModeActive()
      && transcriptView.getAvailability() === "available";
    dom.fullPlayerTranscriptSearch.classList.toggle("is-available", available);
    if (!available && isOpen) {
      closeSearch({ focusTrigger: false });
    }
  }

  function updateCounter() {
    const query = dom.fullPlayerTranscriptSearchInput.value.trim();
    const countEl = dom.fullPlayerTranscriptSearchCount;
    const clearBtn = dom.fullPlayerTranscriptSearchClear;

    if (!query) {
      countEl.hidden = true;
      clearBtn.hidden = true;
      countEl.textContent = "";
      return;
    }

    countEl.hidden = false;
    clearBtn.hidden = false;
    if (!matches.length) {
      countEl.textContent = "0 of 0";
      return;
    }
    countEl.textContent = `${activeMatchIndex + 1} of ${matches.length}`;
  }

  function updateNavButtons() {
    const query = dom.fullPlayerTranscriptSearchInput.value.trim();
    const disabled = !query || !matches.length;
    dom.fullPlayerTranscriptSearchPrev.disabled = disabled || activeMatchIndex <= 0;
    dom.fullPlayerTranscriptSearchNext.disabled = disabled || activeMatchIndex >= matches.length - 1;
  }

  function applyMatches(nextMatches, nextActiveIndex) {
    matches = nextMatches;
    activeMatchIndex = nextActiveIndex;
    transcriptView.applySearchHighlights(matches, activeMatchIndex);
    updateCounter();
    updateNavButtons();
  }

  function runSearch(version) {
    const query = dom.fullPlayerTranscriptSearchInput.value.trim();
    if (version !== searchVersion) return;

    if (!query) {
      applyMatches([], -1);
      return;
    }

    const nextMatches = buildSearchIndex(timeline, query);
    if (version !== searchVersion) return;

    const nextActiveIndex = nextMatches.length ? 0 : -1;
    applyMatches(nextMatches, nextActiveIndex);
    if (nextActiveIndex >= 0) {
      void transcriptView.scrollToSearchMatch(nextMatches[nextActiveIndex], { instant: true });
    }
  }

  function scheduleSearch() {
    const version = ++searchVersion;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      runSearch(version);
    }, SEARCH_DEBOUNCE_MS);
  }

  function openSearch() {
    if (!transcriptView.isModeActive() || transcriptView.isFollowing()) return false;
    if (transcriptView.getAvailability() !== "available") return false;

    isOpen = true;
    dom.fullPlayerTranscriptSearch.classList.add("is-open");
    dom.fullPlayerTranscriptSearchTrigger.hidden = true;
    dom.fullPlayerTranscriptSearchBar.hidden = false;
    requestAnimationFrame(() => {
      dom.fullPlayerTranscriptSearchInput.focus({ preventScroll: true });
    });
    return true;
  }

  function closeSearch({ focusTrigger = true } = {}) {
    isOpen = false;
    dom.fullPlayerTranscriptSearch.classList.remove("is-open");
    dom.fullPlayerTranscriptSearchBar.hidden = true;
    dom.fullPlayerTranscriptSearchTrigger.hidden = false;
    if (focusTrigger && dom.fullPlayerTranscriptSearch.classList.contains("is-available")) {
      requestAnimationFrame(() => {
        dom.fullPlayerTranscriptSearchTrigger.focus({ preventScroll: true });
      });
    }
  }

  function doneSearch() {
    searchVersion += 1;
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    dom.fullPlayerTranscriptSearchInput.value = "";
    matches = [];
    activeMatchIndex = -1;
    transcriptView.clearSearchHighlights();
    updateCounter();
    updateNavButtons();
    closeSearch({ focusTrigger: true });
  }

  function clearQuery() {
    dom.fullPlayerTranscriptSearchInput.value = "";
    scheduleSearch();
  }

  function goToMatch(nextIndex) {
    if (!matches.length) return;
    const clamped = Math.max(0, Math.min(nextIndex, matches.length - 1));
    activeMatchIndex = clamped;
    transcriptView.applySearchHighlights(matches, activeMatchIndex);
    updateCounter();
    updateNavButtons();
    void transcriptView.scrollToSearchMatch(matches[activeMatchIndex], { instant: false });
  }

  function goToNextMatch() {
    if (activeMatchIndex < matches.length - 1) {
      goToMatch(activeMatchIndex + 1);
    }
  }

  function goToPreviousMatch() {
    if (activeMatchIndex > 0) {
      goToMatch(activeMatchIndex - 1);
    }
  }

  function canUseKeyboardShortcut() {
    return getIsPlayerOpen()
      && transcriptView.isModeActive()
      && transcriptView.getAvailability() === "available"
      && !transcriptView.isFollowing();
  }

  function handleDocumentKeyDown(event) {
    const isMetaF = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
    if (isMetaF) {
      if (!canUseKeyboardShortcut()) return;
      event.preventDefault();
      openSearch();
      return;
    }

    if (!isOpen) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      goToNextMatch();
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      goToPreviousMatch();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (dom.fullPlayerTranscriptSearchInput.value.trim()) {
        clearQuery();
      } else {
        doneSearch();
      }
    }
  }

  dom.fullPlayerTranscriptSearchTrigger.addEventListener("click", () => {
    openSearch();
  });

  dom.fullPlayerTranscriptSearchDone.addEventListener("click", () => {
    doneSearch();
  });

  dom.fullPlayerTranscriptSearchInput.addEventListener("input", () => {
    scheduleSearch();
  });

  dom.fullPlayerTranscriptSearchClear.addEventListener("click", () => {
    clearQuery();
    dom.fullPlayerTranscriptSearchInput.focus({ preventScroll: true });
  });

  dom.fullPlayerTranscriptSearchPrev.addEventListener("click", () => {
    goToPreviousMatch();
  });

  dom.fullPlayerTranscriptSearchNext.addEventListener("click", () => {
    goToNextMatch();
  });

  document.addEventListener("keydown", handleDocumentKeyDown);

  transcriptView.onFollowingChange((following) => {
    syncRootVisibility();
    if (following) {
      searchVersion += 1;
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
      dom.fullPlayerTranscriptSearchInput.value = "";
      matches = [];
      activeMatchIndex = -1;
      isOpen = false;
      dom.fullPlayerTranscriptSearch.classList.remove("is-open");
      dom.fullPlayerTranscriptSearchBar.hidden = true;
      dom.fullPlayerTranscriptSearchTrigger.hidden = false;
      transcriptView.clearSearchHighlights();
      updateCounter();
      updateNavButtons();
    }
  });

  function handleModeInactive() {
    searchVersion += 1;
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    matches = [];
    activeMatchIndex = -1;
    isOpen = false;
    dom.fullPlayerTranscriptSearchInput.value = "";
    dom.fullPlayerTranscriptSearch.classList.remove("is-open");
    dom.fullPlayerTranscriptSearchBar.hidden = true;
    dom.fullPlayerTranscriptSearchTrigger.hidden = false;
    dom.fullPlayerTranscriptSearch.classList.remove("is-open", "is-available");
    transcriptView.clearSearchHighlights();
    updateCounter();
    updateNavButtons();
  }

  syncRootVisibility();

  return {
    resetForEpisode,
    setTimeline,
    openSearch,
    closeSearch,
    doneSearch,
    syncRootVisibility,
    handleModeInactive,
  };
}
