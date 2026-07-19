const SEARCH_DEBOUNCE_MS = 150;

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search query operators:
 * - `"exact phrase"` — whole-word consecutive match (also works for a single word)
 * - `-term` / `-"exact phrase"` — exclude matches that contain the term/phrase
 * - `OR` — either side of the operator may match (case-sensitive keyword)
 * - spaces — AND (all terms/phrases required); unquoted terms keep substring matching
 *
 * Unquoted multi-word queries still require consecutive words (existing behavior).
 */
export function parseSearchQuery(rawQuery) {
  const raw = String(rawQuery || "").trim();
  if (!raw) {
    return emptyParsedQuery(raw);
  }

  const lexemes = lexSearchQuery(raw);
  if (!lexemes.length) {
    return emptyParsedQuery(raw);
  }

  const orBranches = [[]];
  const exclude = [];

  for (const lexeme of lexemes) {
    if (lexeme.type === "or") {
      if (orBranches[orBranches.length - 1].length) orBranches.push([]);
      continue;
    }
    if (lexeme.exclude) {
      const clause = toClause(lexeme);
      if (clause) exclude.push(clause);
      continue;
    }
    const clause = toClause(lexeme);
    if (!clause) continue;
    const branch = orBranches[orBranches.length - 1];
    // Adjacent unquoted soft terms stay one consecutive phrase (legacy behavior).
    // Quoted phrases and OR/- boundaries start a new clause.
    if (
      !clause.exact
      && branch.length
      && !branch[branch.length - 1].exact
    ) {
      const prior = branch[branch.length - 1];
      prior.tokens = [...prior.tokens, ...clause.tokens];
      prior.text = prior.tokens.join(" ");
      prior.type = prior.tokens.length > 1 ? "phrase" : "term";
      continue;
    }
    branch.push(clause);
  }

  const includeBranches = orBranches.filter((branch) => branch.length);
  if (!includeBranches.length && !exclude.length) {
    return emptyParsedQuery(raw);
  }

  const indexTokenGroups = includeBranches.map((branch) => (
    branch.flatMap((clause) => clause.tokens)
  )).filter((tokens) => tokens.length);

  const allIncludeTokens = [...new Set(indexTokenGroups.flat())];
  const normalizedLength = allIncludeTokens.join(" ").length
    || exclude.flatMap((clause) => clause.tokens).join(" ").length;

  return {
    raw,
    includeBranches: includeBranches.length ? includeBranches : [[]],
    exclude,
    indexTokenGroups: indexTokenGroups.length ? indexTokenGroups : [[]],
    allIncludeTokens,
    hasOperators: lexemes.some((lexeme) => (
      lexeme.type === "or"
      || lexeme.exclude
      || lexeme.type === "phrase"
    )),
    normalizedLength,
    isEmpty: !includeBranches.length && !exclude.length,
  };
}

function emptyParsedQuery(raw = "") {
  return {
    raw,
    includeBranches: [[]],
    exclude: [],
    indexTokenGroups: [[]],
    allIncludeTokens: [],
    hasOperators: false,
    normalizedLength: 0,
    isEmpty: true,
  };
}

function lexSearchQuery(raw) {
  const lexemes = [];
  const pattern = /"([^"]*)"|(\bOR\b)|(-?)(\S+)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1] != null) {
      const phrase = match[1];
      const prev = raw.slice(0, match.index);
      const exclude = /-\s*$/.test(prev);
      if (exclude && lexemes.length && lexemes[lexemes.length - 1].type === "term" && lexemes[lexemes.length - 1].raw === "-") {
        lexemes.pop();
      }
      lexemes.push({ type: "phrase", raw: phrase, exclude: exclude || false });
      continue;
    }
    if (match[2]) {
      lexemes.push({ type: "or", raw: "OR" });
      continue;
    }
    const exclude = match[3] === "-";
    const value = match[4] || "";
    if (exclude && value.startsWith('"')) {
      // Rare: -"phrase handled by phrase branch when written as - "phrase" with space;
      // -"phrase" without space is captured here as -"phrase"
      const inner = value.replace(/^"/, "").replace(/"$/, "");
      lexemes.push({ type: "phrase", raw: inner, exclude: true });
      continue;
    }
    if (exclude && !value) {
      lexemes.push({ type: "term", raw: "-", exclude: false });
      continue;
    }
    lexemes.push({ type: "term", raw: value, exclude });
  }
  return lexemes.filter((lexeme) => !(lexeme.type === "term" && lexeme.raw === "-"));
}

function toClause(lexeme) {
  const normalized = normalizeSearchText(lexeme.raw);
  if (!normalized) return null;
  const tokens = normalized.split(" ").filter(Boolean);
  if (!tokens.length) return null;
  return {
    type: lexeme.type === "phrase" || tokens.length > 1 ? "phrase" : "term",
    exact: lexeme.type === "phrase",
    tokens,
    text: normalized,
  };
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

function wordMatchesToken(normWord, token, exact) {
  if (!token) return false;
  if (exact) return normWord === token;
  return normWord.includes(token);
}

function findClauseMatches(normalizedWords, words, clause) {
  const matches = [];
  const { tokens, exact } = clause;
  if (!tokens.length) return matches;

  if (tokens.length === 1) {
    const token = tokens[0];
    for (let wordIndex = 0; wordIndex < normalizedWords.length; wordIndex += 1) {
      if (!wordMatchesToken(normalizedWords[wordIndex], token, exact)) continue;
      if (exact) {
        matches.push({
          wordIndex,
          wordCount: 1,
          charStart: 0,
          charLength: words[wordIndex].body.length,
        });
        continue;
      }
      const ranges = findWordSubstringRanges(words[wordIndex].body, token);
      for (const range of ranges) {
        matches.push({ wordIndex, wordCount: 1, ...range });
      }
    }
    return matches;
  }

  if (!exact) {
    const joinedQuery = tokens.join(" ");
    for (let wordIndex = 0; wordIndex < normalizedWords.length; wordIndex += 1) {
      if (!normalizedWords[wordIndex].includes(joinedQuery)) continue;
      const ranges = findWordSubstringRanges(words[wordIndex].body, joinedQuery);
      for (const range of ranges) {
        matches.push({ wordIndex, wordCount: 1, ...range });
      }
    }
  }

  for (let start = 0; start <= normalizedWords.length - tokens.length; start += 1) {
    let matched = true;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      if (!wordMatchesToken(normalizedWords[start + tokenIndex], tokens[tokenIndex], exact)) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    matches.push({
      wordIndex: start,
      wordCount: tokens.length,
      tokenHighlights: tokens.map((token, tokenIndex) => {
        if (exact) {
          return {
            charStart: 0,
            charLength: words[start + tokenIndex].body.length,
          };
        }
        const ranges = findWordSubstringRanges(words[start + tokenIndex].body, token);
        return ranges[0] || null;
      }),
    });
  }

  return matches;
}

function segmentContainsClause(normalizedWords, clause) {
  const { tokens, exact } = clause;
  if (!tokens.length) return false;
  if (tokens.length === 1) {
    return normalizedWords.some((word) => wordMatchesToken(word, tokens[0], exact));
  }
  for (let start = 0; start <= normalizedWords.length - tokens.length; start += 1) {
    let matched = true;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      if (!wordMatchesToken(normalizedWords[start + tokenIndex], tokens[tokenIndex], exact)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  if (!exact) {
    return normalizedWords.some((word) => word.includes(clause.text));
  }
  return false;
}

function textContainsClause(normalizedHaystack, clause) {
  if (!clause?.tokens?.length) return false;
  if (clause.exact) {
    const hayTokens = normalizedHaystack.split(" ").filter(Boolean);
    if (clause.tokens.length === 1) {
      return hayTokens.includes(clause.tokens[0]);
    }
    for (let start = 0; start <= hayTokens.length - clause.tokens.length; start += 1) {
      let matched = true;
      for (let i = 0; i < clause.tokens.length; i += 1) {
        if (hayTokens[start + i] !== clause.tokens[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
    return false;
  }
  if (clause.tokens.length === 1) {
    return normalizedHaystack.includes(clause.tokens[0]);
  }
  // Soft multi-word: consecutive token substrings OR whole joined substring
  if (normalizedHaystack.includes(clause.text)) return true;
  const hayTokens = normalizedHaystack.split(" ").filter(Boolean);
  for (let start = 0; start <= hayTokens.length - clause.tokens.length; start += 1) {
    let matched = true;
    for (let i = 0; i < clause.tokens.length; i += 1) {
      if (!hayTokens[start + i].includes(clause.tokens[i])) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function branchMatchesText(normalizedHaystack, branch) {
  if (!branch.length) return true;
  return branch.every((clause) => textContainsClause(normalizedHaystack, clause));
}

function textMatchesParsedQuery(normalizedHaystack, parsed) {
  if (!parsed || parsed.isEmpty) return false;
  const includeOk = !parsed.includeBranches?.length
    || parsed.includeBranches.some((branch) => !branch.length || branchMatchesText(normalizedHaystack, branch));
  if (!includeOk) return false;
  if (parsed.exclude?.some((clause) => textContainsClause(normalizedHaystack, clause))) {
    return false;
  }
  return parsed.includeBranches.some((branch) => branch.length) || parsed.exclude.length > 0;
}

export function episodeMatchesSearchQuery(episode, rawQueryOrParsed) {
  const parsed = typeof rawQueryOrParsed === "string"
    ? parseSearchQuery(rawQueryOrParsed)
    : rawQueryOrParsed;
  if (!parsed || parsed.isEmpty) return false;
  if (!parsed.includeBranches.some((branch) => branch.length)) {
    // Exclude-only queries are not useful for episode lists
    return false;
  }

  const haystack = normalizeSearchText([
    episode.title,
    episode.date,
    episode.episode,
    episode.type,
    episode.paytch,
    episode.collectionKind,
    episode.episodeKey,
    episode.globalIndex,
    episode.searchableText,
  ].filter(Boolean).join(" "));

  return textMatchesParsedQuery(haystack, parsed);
}

export function buildSearchIndex(timeline, query) {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (!parsed || parsed.isEmpty) return [];
  if (!parsed.includeBranches.some((branch) => branch.length)) return [];

  const segmentWords = [];
  for (let entryIndex = 0; entryIndex < timeline.length; entryIndex += 1) {
    const entry = timeline[entryIndex];
    if (entry.type !== "segment") continue;
    segmentWords.push({
      entryIndex,
      words: entry.words,
      normalizedWords: entry.words.map((word) => normalizeSearchText(word.body)),
    });
  }

  const timelineContainsClause = (clause) => (
    segmentWords.some((segment) => segmentContainsClause(segment.normalizedWords, clause))
  );

  if (parsed.exclude.some((clause) => timelineContainsClause(clause))) {
    return [];
  }

  const matchingBranches = parsed.includeBranches.filter((branch) => (
    branch.length
    && branch.every((clause) => timelineContainsClause(clause))
  ));
  if (!matchingBranches.length) return [];

  const matches = [];
  const seen = new Set();

  for (const segment of segmentWords) {
    for (const branch of matchingBranches) {
      // Highlight every clause that appears in this segment. Episode-level AND
      // already ensured all clauses exist somewhere in the transcript.
      for (const clause of branch) {
        for (const match of findClauseMatches(segment.normalizedWords, segment.words, clause)) {
          const key = `${segment.entryIndex}:${match.wordIndex}:${match.wordCount}:${match.charStart ?? ""}:${match.charLength ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ entryIndex: segment.entryIndex, ...match });
        }
      }
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
