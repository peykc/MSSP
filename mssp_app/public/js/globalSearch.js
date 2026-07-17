import { normalizeSearchText, buildSearchIndex } from "./player/transcriptSearch.js?v=search-multi-mark";
import { buildTranscriptTimeline } from "./player/transcriptView.js";
import { SOURCE_STATUSES } from "./player/sourceStatus.js";
import { debounce, formatEpisodeLabel, formatPlayerDate } from "./utils.js";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const EPISODE_RESULT_LIMIT = 24;
const TRANSCRIPT_BATCH_SIZE = 8;
const TRANSCRIPT_HYDRATE_CONCURRENCY = 4;
const TRANSCRIPT_INITIAL_HEADERS = 16;
const MAX_HITS_PER_EPISODE = 25;
const PREFIX_EXPANSION_LIMIT = 50;
const TIMELINE_CACHE_LIMIT = 48;
const SNIPPET_WORDS_BEFORE = 6;
const SNIPPET_WORDS_AFTER = 8;
const PLAY_PRE_ROLL_SECONDS = 2;
const DEFAULT_TRANSCRIPT_BASE_URL = "https://transcripts.pkcollection.net/mssp";

const MODE_EPISODES = "episodes";
const MODE_TRANSCRIPTS = "transcripts";
const SORT_RELEVANCE = "relevance";
const SORT_DATE = "date";
const SORT_FORWARD = "forward";
const SORT_REVERSE = "reverse";

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

function getEpisodeSortTime(episode) {
  if (!episode) return Number.POSITIVE_INFINITY;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(episode.date || ""));
  if (match) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = Date.parse(episode.date || "");
  if (!Number.isNaN(parsed)) return parsed;
  return Number(episode.globalIndex) || Number.POSITIVE_INFINITY;
}

function scoreEpisodeRelevance(episode, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const title = normalizeSearchText(episode.title || "");
  const label = normalizeSearchText(formatEpisodeLabel(episode));
  const haystack = normalizeSearchText([
    episode.title,
    episode.date,
    episode.episode,
    episode.type,
    episode.paytch,
    episode.collectionKind,
    episode.episodeKey,
    episode.globalIndex,
  ].filter(Boolean).join(" "));

  let score = 0;
  if (title === normalizedQuery) score += 1200;
  if (title.startsWith(normalizedQuery)) score += 600;
  if (label === normalizedQuery || label.includes(normalizedQuery)) score += 400;

  const titleIndex = title.indexOf(normalizedQuery);
  if (titleIndex >= 0) {
    score += 300 + Math.max(0, 80 - titleIndex);
    score += Math.max(0, 120 - title.length);
  } else if (haystack.includes(normalizedQuery)) {
    score += 80;
  }

  for (const token of normalizedQuery.split(" ").filter(Boolean)) {
    if (title.includes(token)) score += 45;
    else if (haystack.includes(token)) score += 12;
  }

  return score;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
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
  let sortMode = SORT_RELEVANCE;
  let sortDirection = SORT_FORWARD;
  let activeQuery = "";
  let episodeResults = [];
  let episodeSlots = [];
  let transcriptCandidates = [];
  let transcriptCandidateMeta = [];
  let transcriptHydrateCursor = 0;
  let transcriptHeaderThrough = 0;
  let transcriptStatus = "idle";
  let transcriptLoadingMore = false;
  let coverageStats = null;
  const collapsedEpisodeKeys = new Set();
  const renderedTranscriptKeys = new Set();
  const shardCache = new Map();
  const timelineCache = new Map();
  let optionCounter = 0;
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

    const hitCounts = new Map();
    perTokenPostings.forEach((postings, index) => {
      for (const [ordinal, count] of postings) {
        if (index > 0 && !hitCounts.has(ordinal)) continue;
        hitCounts.set(ordinal, (hitCounts.get(ordinal) || 0) + count);
      }
      if (index > 0) {
        for (const ordinal of [...hitCounts.keys()]) {
          if (!postings.has(ordinal)) hitCounts.delete(ordinal);
        }
      }
    });

    return [...hitCounts.entries()].map(([ordinal, hitCount]) => ({
      episodeKey: manifest.episodeKeys[ordinal],
      hitCount,
    }));
  }

  function sortEpisodeResults(episodes, query) {
    const list = episodes.slice();
    const direction = sortDirection === SORT_FORWARD ? 1 : -1;
    if (sortMode === SORT_DATE) {
      list.sort((a, b) => {
        const byDate = getEpisodeSortTime(a) - getEpisodeSortTime(b);
        if (byDate) return byDate * direction;
        return (Number(a.globalIndex || 0) - Number(b.globalIndex || 0)) * direction;
      });
      return list;
    }

    list.sort((a, b) => {
      const byScore = scoreEpisodeRelevance(b, query) - scoreEpisodeRelevance(a, query);
      if (byScore) return byScore * direction;
      return (getEpisodeSortTime(a) - getEpisodeSortTime(b)) * direction;
    });
    return list;
  }

  function sortTranscriptCandidateMeta(meta) {
    const list = meta.slice();
    const direction = sortDirection === SORT_FORWARD ? 1 : -1;
    if (sortMode === SORT_DATE) {
      list.sort((a, b) => {
        const byDate = a.dateMs - b.dateMs;
        if (byDate) return byDate * direction;
        return a.episodeKey.localeCompare(b.episodeKey) * direction;
      });
      return list;
    }

    list.sort((a, b) => {
      const byHits = b.hitCount - a.hitCount;
      if (byHits) return byHits * direction;
      return (a.dateMs - b.dateMs) * direction;
    });
    return list;
  }

  function syncTranscriptCandidatesFromMeta() {
    transcriptCandidateMeta = sortTranscriptCandidateMeta(transcriptCandidateMeta);
    transcriptCandidates = transcriptCandidateMeta.map((entry) => entry.episodeKey);
  }

  function updateSortButton() {
    const isDate = sortMode === SORT_DATE;
    const label = isDate ? "Date" : "Relevance";
    dom.globalSearchSort.dataset.sort = sortMode;
    dom.globalSearchSort.setAttribute("aria-label", `Sort results by ${label.toLowerCase()}. Activate to switch.`);
    dom.globalSearchSortLabel.textContent = label;
    dom.globalSearchSortDirection.dataset.direction = sortDirection;
    dom.globalSearchSortDirection.setAttribute(
      "aria-label",
      sortDirection === SORT_FORWARD ? "Reverse result order" : "Use normal result order",
    );
  }

  async function reloadTranscriptResultsForSort() {
    if (!activeQuery || normalizeSearchText(activeQuery).length < MIN_QUERY_LENGTH) return;
    syncTranscriptCandidatesFromMeta();
    episodeSlots = transcriptCandidateMeta.map((entry) => ({
      episodeKey: entry.episodeKey,
      state: "pending",
    }));
    transcriptHydrateCursor = 0;
    transcriptHeaderThrough = Math.min(TRANSCRIPT_INITIAL_HEADERS, episodeSlots.length);
    transcriptLoadingMore = false;
    collapsedEpisodeKeys.clear();
    renderedTranscriptKeys.clear();
    if (panelEl) panelEl.replaceChildren();
    if (!episodeSlots.length) {
      transcriptStatus = "empty";
      paintActiveMode();
      return;
    }
    transcriptStatus = "loading";
    paintActiveMode();
    const token = queryToken;
    await loadTranscriptBatch(activeQuery, () => token !== queryToken);
    if (token !== queryToken) return;
    syncTranscriptStatusAfterHydration();
    paintActiveMode();
  }

  function cycleSortMode() {
    sortMode = sortMode === SORT_RELEVANCE ? SORT_DATE : SORT_RELEVANCE;
    sortDirection = SORT_FORWARD;
    updateSortButton();
    if (!activeQuery || normalizeSearchText(activeQuery).length < MIN_QUERY_LENGTH) return;

    episodeResults = sortEpisodeResults(episodeResults, activeQuery);
    paintActiveMode();
    if (transcriptCandidateMeta.length) {
      void reloadTranscriptResultsForSort();
    }
  }

  function flipSortDirection() {
    sortDirection = sortDirection === SORT_FORWARD ? SORT_REVERSE : SORT_FORWARD;
    updateSortButton();
    if (!activeQuery || normalizeSearchText(activeQuery).length < MIN_QUERY_LENGTH) return;

    episodeResults = sortEpisodeResults(episodeResults, activeQuery);
    paintActiveMode();
    if (transcriptCandidateMeta.length) {
      void reloadTranscriptResultsForSort();
    }
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

  function getReadyEpisodeSlotCount() {
    return episodeSlots.filter((slot) => slot.state === "ready").length;
  }

  function syncTranscriptStatusAfterHydration() {
    if (getReadyEpisodeSlotCount()) {
      transcriptStatus = "ready";
      return;
    }
    if (transcriptHydrateCursor >= transcriptCandidates.length) {
      transcriptStatus = "empty";
      return;
    }
    transcriptStatus = "loading";
  }

  function initEpisodeSlotsFromCandidates() {
    episodeSlots = transcriptCandidateMeta.map((entry) => ({
      episodeKey: entry.episodeKey,
      state: "pending",
    }));
    transcriptHydrateCursor = 0;
    transcriptHeaderThrough = Math.min(TRANSCRIPT_INITIAL_HEADERS, episodeSlots.length);
  }

  function getDisplaySlots() {
    const limit = Math.max(transcriptHydrateCursor, transcriptHeaderThrough);
    return episodeSlots.slice(0, limit).filter((slot) => slot.state !== "empty");
  }

  function transcriptGroupSelector(episodeKey) {
    return `.launch-search__group[data-episode-key="${CSS.escape(episodeKey)}"]`;
  }

  function insertTranscriptGroup(group) {
    if (!panelEl || !group) return;
    const skeleton = panelEl.querySelector(".launch-search__load-skeleton");
    if (skeleton) panelEl.insertBefore(group, skeleton);
    else panelEl.append(group);
  }

  function appendHitsToGroup(group, slot) {
    if (!slot.matches?.length) return;
    const visibleMatches = slot.matches.slice(0, MAX_HITS_PER_EPISODE);
    for (const match of visibleMatches) {
      const startTime = slot.timeline[match.entryIndex].words[match.wordIndex].startTime;
      const episode = getEpisodeByKey(slot.episodeKey);
      const hit = createResultButton(
        () => onPlayEpisodeAtTime(episode, Math.max(0, startTime - PLAY_PRE_ROLL_SECONDS)),
        "launch-search__result launch-search__hit",
      );
      hit.append(createSnippet(slot.timeline, match));
      group.append(hit);
    }
    if (slot.matches.length > MAX_HITS_PER_EPISODE) {
      const overflow = document.createElement("div");
      overflow.className = "launch-search__hit-overflow";
      overflow.textContent = `+${slot.matches.length - MAX_HITS_PER_EPISODE} more matches in this episode`;
      group.append(overflow);
    }
  }

  function createTranscriptGroupFromSlot(slot) {
    const episode = getEpisodeByKey(slot.episodeKey);
    if (!episode) return null;

    const group = document.createElement("div");
    const coverKind = episode.coverKind || episode.collectionKind || "anthology";
    group.className = `launch-search__group launch-search__group--${coverKind}`;
    group.dataset.episodeKey = slot.episodeKey;

    const collapsed = collapsedEpisodeKeys.has(slot.episodeKey);
    if (collapsed) group.classList.add("is-collapsed");
    if (slot.state === "pending" || slot.state === "loading") {
      group.classList.add("is-hydrating");
    }

    const head = document.createElement("div");
    head.className = "launch-search__group-head";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "launch-search__collapse";
    toggle.setAttribute("aria-label", collapsed ? "Expand transcript matches" : "Collapse transcript matches");
    toggle.innerHTML = CHEVRON_ICON;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleEpisodeCollapse(slot.episodeKey);
    });

    const main = createResultButton(() => {
      onSelectEpisode?.(episode);
    }, "launch-search__result launch-search__group-main");
    main.append(createEpisodeHeadContent(episode));

    const play = createPlayOrLockButton(episode);
    head.append(toggle, main, play);
    group.append(head);

    if (slot.state === "ready" && !collapsed) {
      appendHitsToGroup(group, slot);
      group.dataset.hitsRendered = "true";
    }

    return group;
  }

  function upsertTranscriptGroup(slot) {
    if (!panelEl || !slot) return;

    let group = panelEl.querySelector(transcriptGroupSelector(slot.episodeKey));
    if (!group) {
      group = createTranscriptGroupFromSlot(slot);
      if (!group) return;
      renderedTranscriptKeys.add(slot.episodeKey);
      insertTranscriptGroup(group);
      return;
    }

    group.classList.toggle("is-hydrating", slot.state === "pending" || slot.state === "loading");
    group.classList.toggle("is-collapsed", collapsedEpisodeKeys.has(slot.episodeKey));

    if (slot.state === "ready" && group.dataset.hitsRendered !== "true" && !collapsedEpisodeKeys.has(slot.episodeKey)) {
      appendHitsToGroup(group, slot);
      group.dataset.hitsRendered = "true";
    }
  }

  async function hydrateEpisodeSlot(slot, query) {
    slot.state = "loading";
    if (activeMode === MODE_TRANSCRIPTS) upsertTranscriptGroup(slot);
    try {
      const timeline = await getTimeline(slot.episodeKey);
      const matches = pickAllSegmentMatches(buildSearchIndex(timeline, query));
      if (!matches.length) {
        slot.state = "empty";
        if (activeMode === MODE_TRANSCRIPTS) {
          panelEl?.querySelector(transcriptGroupSelector(slot.episodeKey))?.remove();
          renderedTranscriptKeys.delete(slot.episodeKey);
        }
        return;
      }
      slot.state = "ready";
      slot.timeline = timeline;
      slot.matches = matches;
    } catch {
      slot.state = "empty";
      if (activeMode === MODE_TRANSCRIPTS) {
        panelEl?.querySelector(transcriptGroupSelector(slot.episodeKey))?.remove();
        renderedTranscriptKeys.delete(slot.episodeKey);
      }
    }
    if (activeMode === MODE_TRANSCRIPTS) upsertTranscriptGroup(slot);
  }

  async function loadTranscriptBatch(query, isStale) {
    if (transcriptLoadingMore) return;
    if (transcriptHydrateCursor >= transcriptCandidates.length) return;

    transcriptLoadingMore = true;
    const batchStart = transcriptHydrateCursor;
    const batchEnd = Math.min(transcriptCandidates.length, batchStart + TRANSCRIPT_BATCH_SIZE);
    const batchSlots = episodeSlots.slice(batchStart, batchEnd);
    transcriptHydrateCursor = batchEnd;
    transcriptHeaderThrough = Math.max(transcriptHeaderThrough, batchEnd);

    const hydrated = await mapConcurrent(
      batchSlots,
      TRANSCRIPT_HYDRATE_CONCURRENCY,
      async (slot) => {
        if (isStale()) return;
        await hydrateEpisodeSlot(slot, query);
      },
    );

    if (isStale()) {
      transcriptLoadingMore = false;
      return;
    }

    void hydrated;
    transcriptLoadingMore = false;
    syncTranscriptStatusAfterHydration();

    if (activeMode === MODE_TRANSCRIPTS) {
      for (const slot of batchSlots) {
        if (slot.state !== "empty") upsertTranscriptGroup(slot);
      }
      syncLoadMoreRow();
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
    button.id = `globalSearchOption-${optionCounter}-${queryToken}`;
    optionCounter += 1;
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

  function isEpisodeLocked(episode) {
    return getSourceStatusForEpisode(episode).id === SOURCE_STATUSES.RSS_REQUIRED;
  }

  function createPlayOrLockButton(episode) {
    const locked = isEpisodeLocked(episode);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "launch-search__play";
    button.setAttribute(
      "aria-label",
      locked
        ? `Link PAYTCH to unlock ${episode.title || formatEpisodeLabel(episode)}`
        : `Play ${episode.title || formatEpisodeLabel(episode)}`,
    );
    button.innerHTML = locked ? LOCK_ICON : PLAY_ICON;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      onPlayEpisode(episode);
    });
    return button;
  }

  function appendMarkedRange(textEl, body, charStart, charLength) {
    const before = body.slice(0, charStart);
    const hit = body.slice(charStart, charStart + charLength);
    const after = body.slice(charStart + charLength);
    if (before) textEl.append(before);
    const mark = document.createElement("mark");
    mark.textContent = hit;
    textEl.append(mark);
    if (after) textEl.append(after);
  }

  function createSnippet(timeline, match) {
    const entry = timeline[match.entryIndex];
    const words = entry.words;
    const matchEnd = match.wordIndex + match.wordCount;
    const start = Math.max(0, match.wordIndex - SNIPPET_WORDS_BEFORE);
    const end = Math.min(words.length, matchEnd + SNIPPET_WORDS_AFTER);

    const snippet = document.createElement("div");
    snippet.className = "launch-search__snippet";

    const timestamp = document.createElement("span");
    timestamp.className = "launch-search__timestamp";
    timestamp.textContent = formatTimestamp(words[match.wordIndex].startTime);
    snippet.append(timestamp);

    const text = document.createElement("span");
    text.className = "launch-search__snippet-text";
    const joinBodies = (from, to) => words.slice(from, to).map((word) => word.body).join(" ");
    if (start < match.wordIndex) {
      text.append(`${start > 0 ? "…" : ""}${joinBodies(start, match.wordIndex)} `);
    }

    if (match.wordCount === 1 && Number.isInteger(match.charStart) && Number.isInteger(match.charLength)) {
      appendMarkedRange(text, words[match.wordIndex].body, match.charStart, match.charLength);
    } else if (Array.isArray(match.tokenHighlights) && match.tokenHighlights.length === match.wordCount) {
      for (let index = 0; index < match.wordCount; index += 1) {
        if (index > 0) text.append(" ");
        const body = words[match.wordIndex + index].body;
        const range = match.tokenHighlights[index];
        if (range && Number.isInteger(range.charStart) && Number.isInteger(range.charLength)) {
          appendMarkedRange(text, body, range.charStart, range.charLength);
        } else {
          const mark = document.createElement("mark");
          mark.textContent = body;
          text.append(mark);
        }
      }
    } else {
      const mark = document.createElement("mark");
      mark.textContent = joinBodies(match.wordIndex, matchEnd);
      text.append(mark);
    }

    if (matchEnd < end) {
      text.append(` ${joinBodies(matchEnd, end)}${end < words.length ? "…" : ""}`);
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
    if (transcriptStatus === "loading" && !getReadyEpisodeSlotCount()) {
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

  function toggleEpisodeCollapse(episodeKey) {
    if (collapsedEpisodeKeys.has(episodeKey)) collapsedEpisodeKeys.delete(episodeKey);
    else collapsedEpisodeKeys.add(episodeKey);

    const group = panelEl?.querySelector(transcriptGroupSelector(episodeKey));
    if (!group) return;

    const collapsed = collapsedEpisodeKeys.has(episodeKey);
    group.classList.toggle("is-collapsed", collapsed);

    const toggle = group.querySelector(".launch-search__collapse");
    if (toggle) {
      toggle.setAttribute(
        "aria-label",
        collapsed ? "Expand transcript matches" : "Collapse transcript matches",
      );
    }

    if (!collapsed && group.dataset.hitsRendered !== "true") {
      const slot = episodeSlots.find((entry) => entry.episodeKey === episodeKey);
      if (slot?.state === "ready") {
        appendHitsToGroup(group, slot);
        group.dataset.hitsRendered = "true";
      }
    }
  }

  function renderTranscriptResults() {
    if (!panelEl) return;

    if (transcriptStatus === "loading" && !getDisplaySlots().length) {
      panelEl.replaceChildren();
      renderedTranscriptKeys.clear();
      panelEl.append(createStatusRow("Searching transcripts…"));
      return;
    }
    if (transcriptStatus === "error") {
      panelEl.replaceChildren();
      renderedTranscriptKeys.clear();
      panelEl.append(createStatusRow("Transcript search unavailable", { error: true }));
      return;
    }
    if (!getDisplaySlots().length && transcriptHydrateCursor >= transcriptCandidates.length) {
      panelEl.replaceChildren();
      renderedTranscriptKeys.clear();
      panelEl.append(createStatusRow("No transcript matches"));
      return;
    }

    for (const slot of getDisplaySlots()) {
      upsertTranscriptGroup(slot);
    }
    syncLoadMoreRow();
  }

  function syncLoadMoreRow() {
    if (!panelEl) return;
    const existing = panelEl.querySelector(".launch-search__load-skeleton");
    if (existing) existing.remove();

    if (transcriptHydrateCursor >= transcriptCandidates.length && !transcriptLoadingMore) return;

    const skeleton = document.createElement("div");
    skeleton.className = "launch-search__load-skeleton";
    skeleton.setAttribute("aria-hidden", "true");

    const collapse = document.createElement("span");
    collapse.className = "launch-search__load-skeleton-control";

    const main = document.createElement("div");
    main.className = "launch-search__load-skeleton-main";
    const cover = document.createElement("span");
    cover.className = "launch-search__load-skeleton-cover";
    const copy = document.createElement("div");
    copy.className = "launch-search__load-skeleton-copy";
    const meta = document.createElement("span");
    meta.className = "launch-search__load-skeleton-meta";
    const title = document.createElement("span");
    title.className = "launch-search__load-skeleton-title";
    copy.append(meta, title);
    main.append(cover, copy);

    const play = document.createElement("span");
    play.className = "launch-search__load-skeleton-control launch-search__load-skeleton-control--play";

    skeleton.append(collapse, main, play);
    panelEl.append(skeleton);
  }

  function renderEpisodeResults() {
    panelEl.replaceChildren();
    renderedTranscriptKeys.clear();
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

      const play = createPlayOrLockButton(episode);

      row.append(select, play);
      panelEl.append(row);
    }
  }

  function paintActiveMode() {
    if (!panelEl) return;
    if (activeMode === MODE_EPISODES) {
      renderEpisodeResults();
    } else {
      renderTranscriptResults();
    }
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
    if (transcriptHydrateCursor >= transcriptCandidates.length) return;
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
    episodeSlots = [];
    transcriptCandidates = [];
    transcriptCandidateMeta = [];
    transcriptHydrateCursor = 0;
    transcriptHeaderThrough = 0;
    transcriptStatus = "loading";
    transcriptLoadingMore = false;
    coverageStats = null;
    collapsedEpisodeKeys.clear();
    renderedTranscriptKeys.clear();
    optionCounter = 0;

    buildShell();
    setExpanded(true);
    paintActiveMode();

    try {
      const payload = await searchEpisodes(query);
      if (isStale()) return;
      episodeResults = sortEpisodeResults(payload?.episodes || [], query);
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
      const candidates = await findCandidateEpisodes(tokens, manifest);
      if (isStale()) return;
      transcriptCandidateMeta = candidates.map((candidate) => {
        const episode = getEpisodeByKey(candidate.episodeKey);
        return {
          episodeKey: candidate.episodeKey,
          hitCount: candidate.hitCount || 0,
          dateMs: getEpisodeSortTime(episode),
        };
      });
      syncTranscriptCandidatesFromMeta();
      initEpisodeSlotsFromCandidates();
      if (!transcriptCandidates.length) {
        transcriptStatus = "empty";
        paintActiveMode();
        return;
      }
      updateSwitcherLabels();
      transcriptStatus = "loading";
      void loadTranscriptBatch(query, isStale);
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
    episodeSlots = [];
    transcriptCandidates = [];
    transcriptCandidateMeta = [];
    transcriptHydrateCursor = 0;
    transcriptHeaderThrough = 0;
    transcriptStatus = "idle";
    coverageStats = null;
    collapsedEpisodeKeys.clear();
    renderedTranscriptKeys.clear();
    optionCounter = 0;
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

  updateSortButton();
  dom.globalSearchSort.addEventListener("click", (event) => {
    event.preventDefault();
    cycleSortMode();
  });
  dom.globalSearchSortDirection.addEventListener("click", (event) => {
    event.preventDefault();
    flipSortDirection();
  });

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
