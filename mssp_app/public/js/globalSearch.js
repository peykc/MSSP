import { normalizeSearchText, buildSearchIndex } from "./player/transcriptSearch.js";
import { buildTranscriptTimeline } from "./player/transcriptView.js";
import { SOURCE_STATUSES } from "./player/sourceStatus.js";
import { debounce, formatEpisodeLabel, formatPlayerDate } from "./utils.js";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const EPISODE_RESULT_LIMIT = 8;
const TRANSCRIPT_EPISODE_LIMIT = 3;
const MAX_TRANSCRIPT_FETCHES = 5;
const MATCHES_PER_EPISODE = 2;
const PREFIX_EXPANSION_LIMIT = 50;
const TIMELINE_CACHE_LIMIT = 10;
const SNIPPET_WORDS_BEFORE = 6;
const SNIPPET_WORDS_AFTER = 8;
const PLAY_PRE_ROLL_SECONDS = 2;
const DEFAULT_TRANSCRIPT_BASE_URL = "https://transcripts.pkcollection.net/mssp";

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

export function createGlobalSearch({
  dom,
  searchEpisodes,
  getEpisodeByKey,
  getSourceStatusForEpisode,
  onPlayEpisode,
  onPlayEpisodeAtTime,
}) {
  let queryToken = 0;
  let manifestPromise = null;
  let activeIndex = -1;
  const shardCache = new Map();
  const timelineCache = new Map();

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

  // Stage 1: shard lookups -> ranked candidate episode ordinals.
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
        // Prefix-expand the token still being typed so results appear as you type.
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

  // Stage 2: fetch top candidate transcripts and locate exact matches.
  async function findTranscriptMatches(query, candidateKeys, isStale) {
    const results = [];
    let fetches = 0;
    for (const episodeKey of candidateKeys) {
      if (results.length >= TRANSCRIPT_EPISODE_LIMIT || fetches >= MAX_TRANSCRIPT_FETCHES) break;
      fetches += 1;
      let timeline;
      try {
        timeline = await getTimeline(episodeKey);
      } catch {
        continue;
      }
      if (isStale()) return results;
      const matches = buildSearchIndex(timeline, query);
      if (!matches.length) continue;

      const picked = [];
      for (const match of matches) {
        if (picked.length >= MATCHES_PER_EPISODE) break;
        if (picked.some((existing) => existing.entryIndex === match.entryIndex)) continue;
        picked.push(match);
      }
      results.push({ episodeKey, timeline, matches: picked, totalMatches: matches.length });
    }
    return results;
  }

  function setExpanded(expanded) {
    dom.globalSearchResults.classList.toggle("is-hidden", !expanded);
    dom.globalSearchInput.setAttribute("aria-expanded", expanded ? "true" : "false");
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

  function createSectionHeader(label) {
    const header = document.createElement("div");
    header.className = "launch-search__section-header";
    header.textContent = label;
    return header;
  }

  function createStatusRow(text, { error = false } = {}) {
    const status = document.createElement("div");
    status.className = `launch-search__status${error ? " is-error" : ""}`;
    status.textContent = text;
    return status;
  }

  function createResultButton(onActivate) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "launch-search__result";
    button.id = `globalSearchOption-${getOptionButtons().length}-${queryToken}`;
    button.setAttribute("role", "option");
    button.addEventListener("click", () => {
      close();
      onActivate();
    });
    return button;
  }

  function createTitleLine(episode) {
    const title = document.createElement("div");
    title.className = "launch-search__result-title";

    const name = document.createElement("span");
    name.className = "launch-search__result-name";
    name.textContent = `${formatEpisodeLabel(episode)} — ${episode.title || episode.episodeKey}`;
    title.append(name);

    const meta = document.createElement("span");
    meta.className = "launch-search__result-meta";
    meta.textContent = formatPlayerDate(episode.date);
    title.append(meta);

    if (getSourceStatusForEpisode(episode).id === SOURCE_STATUSES.RSS_REQUIRED) {
      const lock = document.createElement("span");
      lock.className = "launch-search__result-lock";
      lock.textContent = "🔒 PAYTCH";
      title.append(lock);
    }
    return title;
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

  function renderEpisodeSection(container, episodes) {
    container.append(createSectionHeader("Episodes"));
    if (!episodes.length) {
      container.append(createStatusRow("No episode matches"));
      return;
    }
    for (const episode of episodes.slice(0, EPISODE_RESULT_LIMIT)) {
      const button = createResultButton(() => onPlayEpisode(episode));
      button.append(createTitleLine(episode));
      container.append(button);
    }
  }

  function renderTranscriptResults(container, transcriptResults) {
    for (const result of transcriptResults) {
      const episode = getEpisodeByKey(result.episodeKey);
      if (!episode) continue;
      for (const match of result.matches) {
        const startTime = result.timeline[match.entryIndex].words[match.wordIndex].startTime;
        const button = createResultButton(() => {
          onPlayEpisodeAtTime(episode, Math.max(0, startTime - PLAY_PRE_ROLL_SECONDS));
        });
        button.append(createTitleLine(episode));
        button.append(createSnippet(result.timeline, match));
        container.append(button);
      }
    }
  }

  async function runQuery(rawQuery) {
    const token = ++queryToken;
    const isStale = () => token !== queryToken;
    const query = rawQuery.trim();
    const normalized = normalizeSearchText(query);

    if (normalized.length < MIN_QUERY_LENGTH) {
      setExpanded(false);
      dom.globalSearchResults.replaceChildren();
      return;
    }

    const container = dom.globalSearchResults;
    container.replaceChildren();
    setExpanded(true);

    // Section 1: episode metadata (instant — data is already cached client-side).
    let episodes = [];
    try {
      const payload = await searchEpisodes(query);
      episodes = payload?.episodes || [];
    } catch {
      episodes = [];
    }
    if (isStale()) return;
    renderEpisodeSection(container, episodes);

    // Section 2: transcripts (async, two-stage).
    container.append(createSectionHeader("Transcripts"));
    const pending = createStatusRow("Searching transcripts…");
    container.append(pending);
    setActiveIndex(-1);

    let manifest;
    try {
      manifest = await getManifest();
    } catch {
      if (isStale()) return;
      pending.replaceWith(createStatusRow("Transcript search unavailable", { error: true }));
      return;
    }
    if (isStale()) return;

    const tokens = normalized.split(" ").filter((t) => t.length >= (manifest.minTokenLength || MIN_QUERY_LENGTH));
    let transcriptResults = [];
    try {
      if (tokens.length) {
        const candidates = await findCandidateEpisodes(tokens, manifest);
        if (isStale()) return;
        transcriptResults = await findTranscriptMatches(query, candidates, isStale);
      }
    } catch {
      if (isStale()) return;
      pending.replaceWith(createStatusRow("Transcript search unavailable", { error: true }));
      return;
    }
    if (isStale()) return;

    if (!transcriptResults.length) {
      pending.replaceWith(createStatusRow("No transcript matches"));
    } else {
      pending.remove();
      renderTranscriptResults(container, transcriptResults);
    }

    const footer = document.createElement("div");
    footer.className = "launch-search__footer";
    const stats = manifest.stats || {};
    footer.textContent = `Transcript search covers ${stats.episodesWithTranscripts ?? manifest.episodeKeys.length} of ${stats.episodesTotal ?? "?"} episodes`;
    container.append(footer);
  }

  function close() {
    setExpanded(false);
  }

  function clear() {
    dom.globalSearchInput.value = "";
    queryToken += 1;
    dom.globalSearchResults.replaceChildren();
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
      if (dom.globalSearchInput.value) {
        clear();
      } else {
        close();
      }
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
    if (!dom.globalSearch.contains(event.target)) {
      close();
    }
  });

  return { close, clear };
}
