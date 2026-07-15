import { normalizeSearchText, buildSearchIndex } from "./player/transcriptSearch.js";
import { buildTranscriptTimeline } from "./player/transcriptView.js";
import { SOURCE_STATUSES } from "./player/sourceStatus.js";
import { debounce, formatEpisodeLabel, formatPlayerDate } from "./utils.js";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const EPISODE_RESULT_LIMIT = 24;
const TRANSCRIPT_BATCH_SIZE = 8;
const PREFIX_EXPANSION_LIMIT = 50;
const TIMELINE_CACHE_LIMIT = 48;
const SNIPPET_WORDS_BEFORE = 6;
const SNIPPET_WORDS_AFTER = 8;
const PLAY_PRE_ROLL_SECONDS = 2;
const DEFAULT_TRANSCRIPT_BASE_URL = "https://transcripts.pkcollection.net/mssp";

const MODE_EPISODES = "episodes";
const MODE_TRANSCRIPTS = "transcripts";

const KIND_LABELS = {
  old: "MSSPOT",
  new: "MSSP",
  paytch: "PAYTCH",
  anthology: "MSSP",
};

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

const CHEVRON_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m6 9 6 6 6-6"></path>
  </svg>
`;

function getTranscriptBaseUrl() {
  const override = typeof window !== "undefined" ? window.MSSP_TRANSCRIPT_BASE_URL : "";
  return String(override || DEFAULT_TRANSCRIPT_BASE_URL).replace(/\/+$/, "");
}

function getIndexBaseUrl() {
  const override = typeof window !== "undefined" ? window.MSSP_SEARCH_INDEX_BASE_URL : "";
  return String(override || `${getTranscriptBaseUrl()}/search-index/v1`).replace(/\/+$/, "");
}

function decodePostings(flat) {
  const postings = [];
  let ordinal = 0;
  for (let i = 0; i < flat.length; i += 2) {
    ordinal += flat[i];
    postings.push([ordinal, flat[i + 1]]);
  }
  return postings;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatCountLabel(count, { capped = false } = {}) {
  if (count == null) return "";
  if (capped) return `${count}+`;
  return String(count);
}

function collectionKindLabel(episode) {
  const kind = episode.coverKind || episode.collectionKind || "";
  return KIND_LABELS[kind] || "";
}

export function createGlobalSearch({
  dom,
  searchEpisodes,
  getEpisodeByKey,
  getSourceStatusForEpisode,
  onSelectEpisode,
  onPlayEpisode,
  onPlayEpisodeAtTime,
}) {
  let queryToken = 0;
  let manifestPromise = null;
  let activeIndex = -1;
  let activeMode = MODE_EPISODES;
  let activeQuery = "";
  let episodeResults = [];
  let transcriptResults = [];
  let transcriptCandidates = [];
  let transcriptCursor = 0;
  let transcriptStatus = "idle";
  let transcriptLoadingMore = false;
  let coverageStats = null;
  const collapsedEpisodeKeys = new Set();
  const shardCache = new Map();
  const timelineCache = new Map();
  let panelTouchY = 0;
  let switchEpisodesBtn = null;
  let switchTranscriptsBtn = null;
  let panelEl = null;
  let footerEl = null;

  function fetchJson(url) {
    return fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      return response.json();
    });
  }

  function getManifest() {
    manifestPromise ||= fetchJson(`${getIndexBaseUrl()}/manifest.json`).catch((error) => {
      manifestPromise = null;
      throw error;
    });
    return manifestPromise;
  }

  function getShard(fileName) {
    if (!shardCache.has(fileName)) {
      const request = fetchJson(`${getIndexBaseUrl()}/${fileName}`).catch((error) => {
        shardCache.delete(fileName);
        throw error;
      });
      shardCache.set(fileName, request);
    }
    return shardCache.get(fileName);
  }

  function getTimeline(episodeKey) {
    if (timelineCache.has(episodeKey)) {
      const promise = timelineCache.get(episodeKey);
      timelineCache.delete(episodeKey);
      timelineCache.set(episodeKey, promise);
      return promise;
    }
    const url = `${getTranscriptBaseUrl()}/${encodeURIComponent(episodeKey)}.json`;
    const request = fetchJson(url)
      .then((payload) => buildTranscriptTimeline(payload))
      .catch((error) => {
        timelineCache.delete(episodeKey);
        throw error;
      });
    timelineCache.set(episodeKey, request);
    while (timelineCache.size > TIMELINE_CACHE_LIMIT) {
      timelineCache.delete(timelineCache.keys().next().value);
    }
    return request;
  }

  async function findCandidateEpisodes(tokens, manifest) {
    const uniqueTokens = [...new Set(tokens)];
    const expandToken = tokens[tokens.length - 1];
    const perTokenPostings = await Promise.all(uniqueTokens.map(async (token) => {
      const isLast = token === expandToken;
      const prefix = token.slice(0, 2);
      const shardFile = manifest.shards[prefix];
      if (!shardFile) return new Map();

      const shard = await getShard(shardFile);
      const combined = new Map();
      const addPostings = (flat) => {
        for (const [ordinal, count] of decodePostings(flat)) {
          combined.set(ordinal, (combined.get(ordinal) || 0) + count);
        }
      };

      if (shard.tokens[token]) addPostings(shard.tokens[token]);
      if (isLast) {
        let expansions = 0;
        for (const candidate of Object.keys(shard.tokens)) {
          if (candidate === token || !candidate.startsWith(token)) continue;
          addPostings(shard.tokens[candidate]);
          expansions += 1;
          if (expansions >= PREFIX_EXPANSION_LIMIT) break;
        }
      }
      return combined;
    }));

    if (perTokenPostings.some((postings) => !postings.size)) return [];

    const episodeCount = Math.max(1, manifest.episodeKeys.length);
    const scores = new Map();
    perTokenPostings.forEach((postings, index) => {
      const idf = Math.log(1 + episodeCount / postings.size);
      for (const [ordinal, count] of postings) {
        if (index > 0 && !scores.has(ordinal)) continue;
        scores.set(ordinal, (scores.get(ordinal) || 0) + count * idf);
      }
      if (index > 0) {
        for (const ordinal of [...scores.keys()]) {
          if (!postings.has(ordinal)) scores.delete(ordinal);
        }
      }
    });

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ordinal]) => manifest.episodeKeys[ordinal]);
  }

  function pickAllSegmentMatches(matches) {
    const picked = [];
    const seenEntries = new Set();
    for (const match of matches) {
      if (seenEntries.has(match.entryIndex)) continue;
      seenEntries.add(match.entryIndex);
      picked.push(match);
    }
    return picked;
  }

  async function loadTranscriptBatch(query, isStale) {
    if (transcriptLoadingMore) return;
    if (transcriptCursor >= transcriptCandidates.length) return;

    transcriptLoadingMore = true;
    const batch = [];
    let fetches = 0;

    while (
      batch.length < TRANSCRIPT_BATCH_SIZE
      && transcriptCursor < transcriptCandidates.length
      && fetches < TRANSCRIPT_BATCH_SIZE * 3
    ) {
      const episodeKey = transcriptCandidates[transcriptCursor];
      transcriptCursor += 1;
      fetches += 1;

      let timeline;
      try {
        timeline = await getTimeline(episodeKey);
      } catch {
        continue;
      }
      if (isStale()) {
        transcriptLoadingMore = false;
        return;
      }

      const matches = pickAllSegmentMatches(buildSearchIndex(timeline, query));
      if (!matches.length) continue;
      batch.push({ episodeKey, timeline, matches });
    }

    if (isStale()) {
      transcriptLoadingMore = false;
      return;
    }

    if (batch.length) transcriptResults = transcriptResults.concat(batch);
    transcriptStatus = transcriptResults.length ? "ready" : (transcriptCursor < transcriptCandidates.length ? "loading" : "empty");
    transcriptLoadingMore = false;

    if (activeMode === MODE_TRANSCRIPTS) {
      appendTranscriptBatch(batch);
      updateSwitcherLabels();
      updateFooter();
    } else {
      updateSwitcherLabels();
    }
  }

  function setExpanded(expanded) {
    dom.globalSearchResults.classList.toggle("is-hidden", !expanded);
    dom.globalSearchInput.setAttribute("aria-expanded", expanded ? "true" : "false");
    document.body.classList.toggle("search-results-open", expanded);
    if (!expanded) setActiveIndex(-1);
  }

  function getOptionButtons() {
    return [...dom.globalSearchResults.querySelectorAll(".launch-search__result")];
  }

  function setActiveIndex(index) {
    const buttons = getOptionButtons();
    activeIndex = index;
    buttons.forEach((button, i) => button.classList.toggle("is-active", i === index));
    const active = buttons[index];
    if (active) {
      dom.globalSearchInput.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else {
      dom.globalSearchInput.removeAttribute("aria-activedescendant");
    }
  }

  function createStatusRow(text, { error = false } = {}) {
    const status = document.createElement("div");
    status.className = `launch-search__status${error ? " is-error" : ""}`;
    status.textContent = text;
    return status;
  }

  function createResultButton(onActivate, className = "launch-search__result") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.id = `globalSearchOption-${getOptionButtons().length}-${queryToken}`;
    button.setAttribute("role", "option");
    button.addEventListener("click", () => {
      close();
      onActivate();
    });
    return button;
  }

  function createEpisodeHeadContent(episode) {
    const wrap = document.createElement("div");
    wrap.className = "launch-search__episode";

    const cover = document.createElement("img");
    cover.className = "launch-search__cover";
    cover.src = episode.coverUrl || "./assets/covers/anthology.webp";
    cover.alt = "";
    cover.loading = "lazy";
    cover.decoding = "async";
    wrap.append(cover);

    const body = document.createElement("div");
    body.className = "launch-search__episode-body";

    const top = document.createElement("div");
    top.className = "launch-search__episode-top";

    const epLabel = document.createElement("span");
    epLabel.className = "launch-search__episode-label";
    epLabel.textContent = formatEpisodeLabel(episode);
    top.append(epLabel);

    const kind = collectionKindLabel(episode);
    if (kind) {
      const kindEl = document.createElement("span");
      kindEl.className = `launch-search__kind launch-search__kind--${episode.coverKind || episode.collectionKind || "anthology"}`;
      kindEl.textContent = kind;
      top.append(kindEl);
    }

    if (getSourceStatusForEpisode(episode).id === SOURCE_STATUSES.RSS_REQUIRED) {
      const lock = document.createElement("span");
      lock.className = "launch-search__lock";
      lock.setAttribute("aria-label", "PAYTCH locked");
      lock.innerHTML = LOCK_ICON;
      top.append(lock);
    }

    const meta = document.createElement("span");
    meta.className = "launch-search__result-meta";
    meta.textContent = formatPlayerDate(episode.date);
    top.append(meta);

    const title = document.createElement("div");
    title.className = "launch-search__episode-title";
    title.textContent = episode.title || episode.episodeKey;

    body.append(top, title);
    wrap.append(body);
    return wrap;
  }

  function createSnippet(timeline, match) {
    const entry = timeline[match.entryIndex];
    const words = entry.words;
    const start = Math.max(0, match.wordIndex - SNIPPET_WORDS_BEFORE);
    const end = Math.min(words.length, match.wordIndex + match.wordCount + SNIPPET_WORDS_AFTER);

    const snippet = document.createElement("div");
    snippet.className = "launch-search__snippet";

    const timestamp = document.createElement("span");
    timestamp.className = "launch-search__timestamp";
    timestamp.textContent = formatTimestamp(words[match.wordIndex].startTime);
    snippet.append(timestamp);

    const text = document.createElement("span");
    text.className = "launch-search__snippet-text";
    const joinBodies = (from, to) => words.slice(from, to).map((word) => word.body).join(" ");
    if (start < match.wordIndex) text.append(`${start > 0 ? "…" : ""}${joinBodies(start, match.wordIndex)} `);
    const mark = document.createElement("mark");
    mark.textContent = joinBodies(match.wordIndex, match.wordIndex + match.wordCount);
    text.append(mark);
    if (match.wordIndex + match.wordCount < end) {
      text.append(` ${joinBodies(match.wordIndex + match.wordCount, end)}${end < words.length ? "…" : ""}`);
    }
    snippet.append(text);
    return snippet;
  }

  function updateSwitcherLabels() {
    if (!switchEpisodesBtn || !switchTranscriptsBtn) return;

    switchEpisodesBtn.replaceChildren("Episodes");
    if (episodeResults.length) {
      const badge = document.createElement("span");
      badge.className = "launch-search__switch-count";
      badge.textContent = formatCountLabel(episodeResults.length);
      switchEpisodesBtn.append(badge);
    }

    switchTranscriptsBtn.replaceChildren("Transcripts");
    if (transcriptStatus === "loading" && !transcriptResults.length) {
      const transcriptBadge = document.createElement("span");
      transcriptBadge.className = "launch-search__switch-count";
      transcriptBadge.textContent = "…";
      switchTranscriptsBtn.append(transcriptBadge);
    } else if (transcriptCandidates.length) {
      const transcriptBadge = document.createElement("span");
      transcriptBadge.className = "launch-search__switch-count";
      transcriptBadge.textContent = formatCountLabel(transcriptCandidates.length);
      switchTranscriptsBtn.append(transcriptBadge);
    }

    switchEpisodesBtn.setAttribute("aria-selected", activeMode === MODE_EPISODES ? "true" : "false");
    switchTranscriptsBtn.setAttribute("aria-selected", activeMode === MODE_TRANSCRIPTS ? "true" : "false");
    switchEpisodesBtn.classList.toggle("is-active", activeMode === MODE_EPISODES);
    switchTranscriptsBtn.classList.toggle("is-active", activeMode === MODE_TRANSCRIPTS);
  }

  function updateFooter() {
    if (!footerEl) return;
    if (activeMode === MODE_TRANSCRIPTS && coverageStats) {
      footerEl.hidden = false;
      const withTx = coverageStats.episodesWithTranscripts ?? "?";
      const total = coverageStats.episodesTotal ?? "?";
      footerEl.textContent = `${withTx}/${total} episodes indexed`;
      return;
    }
    footerEl.hidden = true;
    footerEl.textContent = "";
  }

  function createTranscriptGroup(result) {
    const episode = getEpisodeByKey(result.episodeKey);
    if (!episode) return null;

    const group = document.createElement("div");
    const coverKind = episode.coverKind || episode.collectionKind || "anthology";
    group.className = `launch-search__group launch-search__group--${coverKind}`;
    const collapsed = collapsedEpisodeKeys.has(result.episodeKey);
    if (collapsed) group.classList.add("is-collapsed");

    const head = document.createElement("div");
    head.className = "launch-search__group-head";
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    head.id = `globalSearchGroup-${getOptionButtons().length}-${queryToken}`;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "launch-search__collapse";
    toggle.setAttribute("aria-label", collapsed ? "Expand transcript matches" : "Collapse transcript matches");
    toggle.innerHTML = CHEVRON_ICON;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "launch-search__result launch-search__group-main";
    main.setAttribute("role", "option");
    main.id = `globalSearchOption-${getOptionButtons().length}-${queryToken}`;
    main.append(createEpisodeHeadContent(episode));
    main.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      onSelectEpisode?.(episode);
    });

    const play = document.createElement("button");
    play.type = "button";
    play.className = "launch-search__play";
    play.setAttribute("aria-label", `Play ${episode.title || formatEpisodeLabel(episode)}`);
    play.innerHTML = PLAY_ICON;
    play.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      onPlayEpisode(episode);
    });

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = !group.classList.contains("is-collapsed");
      group.classList.toggle("is-collapsed", next);
      head.setAttribute("aria-expanded", next ? "false" : "true");
      toggle.setAttribute("aria-label", next ? "Expand transcript matches" : "Collapse transcript matches");
      if (next) collapsedEpisodeKeys.add(result.episodeKey);
      else collapsedEpisodeKeys.delete(result.episodeKey);
    });

    head.append(toggle, main, play);
    group.append(head);

    for (const match of result.matches) {
      const startTime = result.timeline[match.entryIndex].words[match.wordIndex].startTime;
      const hit = createResultButton(
        () => onPlayEpisodeAtTime(episode, Math.max(0, startTime - PLAY_PRE_ROLL_SECONDS)),
        "launch-search__result launch-search__hit",
      );
      hit.append(createSnippet(result.timeline, match));
      group.append(hit);
    }

    return group;
  }

  function appendTranscriptBatch(batch) {
    if (!panelEl || activeMode !== MODE_TRANSCRIPTS) return;

    const empty = panelEl.querySelector(".launch-search__status");
    if (empty) empty.remove();

    for (const result of batch) {
      const group = createTranscriptGroup(result);
      if (group) panelEl.append(group);
    }

    syncLoadMoreRow();
  }

  function syncLoadMoreRow() {
    if (!panelEl) return;
    const existing = panelEl.querySelector(".launch-search__load-more");
    if (existing) existing.remove();

    if (transcriptCursor >= transcriptCandidates.length && !transcriptLoadingMore) return;

    const row = document.createElement("div");
    row.className = "launch-search__load-more";
    row.textContent = transcriptLoadingMore
      ? "Loading more matches…"
      : "Scroll for more matches";
    panelEl.append(row);
  }

  function renderEpisodeResults() {
    panelEl.replaceChildren();
    if (!episodeResults.length) {
      panelEl.append(createStatusRow("No episode matches"));
      return;
    }
    for (const episode of episodeResults.slice(0, EPISODE_RESULT_LIMIT)) {
      const row = document.createElement("div");
      row.className = "launch-search__episode-row";

      const select = createResultButton(() => {
        onSelectEpisode?.(episode);
      }, "launch-search__result launch-search__episode-select");
      select.append(createEpisodeHeadContent(episode));

      const play = document.createElement("button");
      play.type = "button";
      play.className = "launch-search__play";
      play.setAttribute("aria-label", `Play ${episode.title || formatEpisodeLabel(episode)}`);
      play.innerHTML = PLAY_ICON;
      play.addEventListener("click", (event) => {
        event.stopPropagation();
        close();
        onPlayEpisode(episode);
      });

      row.append(select, play);
      panelEl.append(row);
    }
  }

  function renderTranscriptResults() {
    panelEl.replaceChildren();

    if (transcriptStatus === "loading" && !transcriptResults.length) {
      panelEl.append(createStatusRow("Searching transcripts…"));
      return;
    }
    if (transcriptStatus === "error") {
      panelEl.append(createStatusRow("Transcript search unavailable", { error: true }));
      return;
    }
    if (!transcriptResults.length) {
      panelEl.append(createStatusRow("No transcript matches"));
      return;
    }

    for (const result of transcriptResults) {
      const group = createTranscriptGroup(result);
      if (group) panelEl.append(group);
    }
    syncLoadMoreRow();
  }

  function paintActiveMode() {
    if (!panelEl) return;
    if (activeMode === MODE_EPISODES) renderEpisodeResults();
    else renderTranscriptResults();
    updateSwitcherLabels();
    updateFooter();
    setActiveIndex(-1);
  }

  function setMode(mode) {
    if (mode !== MODE_EPISODES && mode !== MODE_TRANSCRIPTS) return;
    if (activeMode === mode) return;
    activeMode = mode;
    paintActiveMode();
  }

  async function maybeLoadMoreFromScroll() {
    if (activeMode !== MODE_TRANSCRIPTS || !panelEl) return;
    if (transcriptLoadingMore) return;
    if (transcriptCursor >= transcriptCandidates.length) return;
    const remaining = panelEl.scrollHeight - panelEl.scrollTop - panelEl.clientHeight;
    if (remaining > 120) return;
    const token = queryToken;
    await loadTranscriptBatch(activeQuery, () => token !== queryToken);
  }

  function buildShell() {
    const container = dom.globalSearchResults;
    container.replaceChildren();

    const chrome = document.createElement("div");
    chrome.className = "launch-search__chrome";

    const switcher = document.createElement("div");
    switcher.className = "launch-search__switch";
    switcher.setAttribute("role", "tablist");
    switcher.setAttribute("aria-label", "Search result type");

    switchEpisodesBtn = document.createElement("button");
    switchEpisodesBtn.type = "button";
    switchEpisodesBtn.className = "launch-search__switch-tab";
    switchEpisodesBtn.setAttribute("role", "tab");
    switchEpisodesBtn.addEventListener("click", () => setMode(MODE_EPISODES));

    switchTranscriptsBtn = document.createElement("button");
    switchTranscriptsBtn.type = "button";
    switchTranscriptsBtn.className = "launch-search__switch-tab";
    switchTranscriptsBtn.setAttribute("role", "tab");
    switchTranscriptsBtn.addEventListener("click", () => setMode(MODE_TRANSCRIPTS));

    switcher.append(switchEpisodesBtn, switchTranscriptsBtn);
    chrome.append(switcher);

    panelEl = document.createElement("div");
    panelEl.className = "launch-search__panel";
    panelEl.setAttribute("role", "presentation");
    panelEl.addEventListener("scroll", () => {
      void maybeLoadMoreFromScroll();
    }, { passive: true });
    panelEl.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return;
      panelTouchY = event.touches[0].clientY;
    }, { passive: true });
    panelEl.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      const dy = y - panelTouchY;
      panelTouchY = y;
      const maxScroll = panelEl.scrollHeight - panelEl.clientHeight;
      if (maxScroll <= 0) {
        event.preventDefault();
        return;
      }
      const atTop = panelEl.scrollTop <= 0;
      const atBottom = panelEl.scrollTop >= maxScroll - 1;
      // Finger moving down (dy > 0) scrolls content toward the start.
      if ((atTop && dy > 0) || (atBottom && dy < 0)) {
        event.preventDefault();
        return;
      }
      // Keep the gesture inside the panel so #app / pull-to-refresh cannot steal it.
      event.preventDefault();
      panelEl.scrollTop -= dy;
    }, { passive: false });

    footerEl = document.createElement("div");
    footerEl.className = "launch-search__footer";
    footerEl.hidden = true;

    container.append(chrome, panelEl, footerEl);
    updateSwitcherLabels();
  }

  async function runQuery(rawQuery) {
    const token = ++queryToken;
    const isStale = () => token !== queryToken;
    const query = rawQuery.trim();
    const normalized = normalizeSearchText(query);

    if (normalized.length < MIN_QUERY_LENGTH) {
      setExpanded(false);
      dom.globalSearchResults.replaceChildren();
      panelEl = null;
      footerEl = null;
      switchEpisodesBtn = null;
      switchTranscriptsBtn = null;
      return;
    }

    activeMode = MODE_EPISODES;
    activeQuery = query;
    episodeResults = [];
    transcriptResults = [];
    transcriptCandidates = [];
    transcriptCursor = 0;
    transcriptStatus = "loading";
    transcriptLoadingMore = false;
    coverageStats = null;
    collapsedEpisodeKeys.clear();

    buildShell();
    setExpanded(true);
    paintActiveMode();

    try {
      const payload = await searchEpisodes(query);
      if (isStale()) return;
      episodeResults = payload?.episodes || [];
    } catch {
      if (isStale()) return;
      episodeResults = [];
    }
    paintActiveMode();

    let manifest;
    try {
      manifest = await getManifest();
    } catch {
      if (isStale()) return;
      transcriptStatus = "error";
      paintActiveMode();
      return;
    }
    if (isStale()) return;

    coverageStats = manifest.stats || {
      episodesWithTranscripts: manifest.episodeKeys?.length,
      episodesTotal: undefined,
    };

    const tokens = normalized.split(" ").filter((t) => t.length >= (manifest.minTokenLength || MIN_QUERY_LENGTH));
    try {
      if (!tokens.length) {
        transcriptStatus = "empty";
        paintActiveMode();
        return;
      }
      transcriptCandidates = await findCandidateEpisodes(tokens, manifest);
      if (isStale()) return;
      if (!transcriptCandidates.length) {
        transcriptStatus = "empty";
        paintActiveMode();
        return;
      }
      updateSwitcherLabels();
      await loadTranscriptBatch(query, isStale);
      if (isStale()) return;
      if (!transcriptResults.length && transcriptCursor >= transcriptCandidates.length) {
        transcriptStatus = "empty";
      } else if (transcriptResults.length) {
        transcriptStatus = "ready";
      }
      paintActiveMode();
    } catch {
      if (isStale()) return;
      transcriptStatus = "error";
      paintActiveMode();
    }
  }

  function close() {
    setExpanded(false);
  }

  function clear() {
    dom.globalSearchInput.value = "";
    queryToken += 1;
    episodeResults = [];
    transcriptResults = [];
    transcriptCandidates = [];
    transcriptCursor = 0;
    transcriptStatus = "idle";
    coverageStats = null;
    collapsedEpisodeKeys.clear();
    document.body.classList.remove("search-results-open");
    dom.globalSearchResults.replaceChildren();
    panelEl = null;
    footerEl = null;
    switchEpisodesBtn = null;
    switchTranscriptsBtn = null;
    setExpanded(false);
  }

  const scheduleQuery = debounce((value) => {
    void runQuery(value);
  }, SEARCH_DEBOUNCE_MS);

  dom.globalSearchInput.addEventListener("input", () => {
    scheduleQuery(dom.globalSearchInput.value);
  });

  dom.globalSearchInput.addEventListener("focus", () => {
    if (dom.globalSearchInput.value.trim() && dom.globalSearchResults.childElementCount) {
      setExpanded(true);
    }
  });

  dom.globalSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (dom.globalSearchInput.value) clear();
      else close();
      return;
    }

    const buttons = getOptionButtons();
    if (!buttons.length || dom.globalSearchResults.classList.contains("is-hidden")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(activeIndex + 1, buttons.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter" && activeIndex >= 0 && buttons[activeIndex]) {
      event.preventDefault();
      buttons[activeIndex].click();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!dom.globalSearch.contains(event.target)) close();
  });

  return { close, clear };
}
