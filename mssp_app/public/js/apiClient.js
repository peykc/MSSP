(function () {
  const DATA_SOURCE_KEY = "mssp:dataSource";
  const STATIC_MODE = "static";
  const API_MODE = "api";

  let mode = getInitialMode();
  let collectionsPromise = null;
  let episodesPromise = null;
  let healthPromise = null;
  const episodeRequestCache = new Map();

  function getInitialMode() {
    const source = new URLSearchParams(window.location.search).get("source");
    if (source === STATIC_MODE || source === API_MODE) return source;

    try {
      return window.localStorage.getItem(DATA_SOURCE_KEY) === API_MODE ? API_MODE : STATIC_MODE;
    } catch {
      return STATIC_MODE;
    }
  }

  function getMode() {
    return mode;
  }

  async function getCollections() {
    if (mode === API_MODE) {
      try {
        return await fetchJson("/api/collections");
      } catch (error) {
        return fallbackToStatic(error, getStaticCollections);
      }
    }
    return getStaticCollections();
  }

  async function getEpisodes({ collection = "anthology", query = "" } = {}) {
    const cacheKey = query ? "" : collection;
    if (cacheKey && episodeRequestCache.has(cacheKey)) return episodeRequestCache.get(cacheKey);
    const request = loadEpisodes({ collection, query });
    if (cacheKey) episodeRequestCache.set(cacheKey, request);
    try {
      return await request;
    } catch (error) {
      if (cacheKey) episodeRequestCache.delete(cacheKey);
      throw error;
    }
  }

  async function loadEpisodes({ collection = "anthology", query = "" } = {}) {
    if (mode === API_MODE) {
      try {
        const url = new URL("/api/episodes", window.location.origin);
        url.searchParams.set("collection", collection);
        if (query) url.searchParams.set("q", query);
        return await fetchJson(url);
      } catch (error) {
        return fallbackToStatic(error, () => getStaticEpisodes({ collection, query }));
      }
    }
    return getStaticEpisodes({ collection, query });
  }

  async function getHealth() {
    if (mode === API_MODE) {
      try {
        return await fetchJson("/api/health");
      } catch (error) {
        return fallbackToStatic(error, getStaticHealth);
      }
    }
    return getStaticHealth();
  }

  async function fallbackToStatic(error, loader) {
    console.warn("[MSSP] API data source failed; using static data.", error);
    mode = STATIC_MODE;
    return loader();
  }

  async function getStaticCollections() {
    const data = await loadStaticCollections();
    return {
      total: data.total,
      collections: data.collections,
    };
  }

  async function getStaticEpisodes({ collection = "anthology", query = "" } = {}) {
    const data = await loadStaticEpisodes();
    let episodes = data.episodes || [];

    if (collection !== "anthology") {
      episodes = episodes.filter((episode) => episode.collectionKind === collection);
    }

    const normalizedQuery = normalizeSearch(query);
    if (normalizedQuery) {
      episodes = episodes.filter((episode) => getEpisodeSearchText(episode).includes(normalizedQuery));
    }

    episodes = episodes
      .slice()
      .sort((a, b) => Number(a.globalIndex || 0) - Number(b.globalIndex || 0));

    return {
      collection,
      count: episodes.length,
      metadataDiagnostics: collection === "anthology" && !query ? data.metadataDiagnostics : undefined,
      episodes,
    };
  }

  async function getStaticHealth() {
    return loadStaticHealth();
  }

  function loadStaticCollections() {
    collectionsPromise ||= fetchJson("./data/collections.json");
    return collectionsPromise;
  }

  function loadStaticEpisodes() {
    episodesPromise ||= fetchJson("./data/episodes.json");
    return episodesPromise;
  }

  function loadStaticHealth() {
    healthPromise ||= fetchJson("./data/health.json");
    return healthPromise;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  }

  function getEpisodeSearchText(episode) {
    const accessSynonyms = episode.paytch === "PAYTCH" ? "Patreon paid bonus" : "";
    return normalizeSearch([
      episode.title,
      episode.date,
      episode.episode,
      episode.type,
      episode.paytch,
      episode.collectionKind,
      episode.episodeKey,
      episode.globalIndex,
      accessSynonyms,
    ].filter(Boolean).join(" "));
  }

  function normalizeSearch(value) {
    return String(value || "").trim().toLowerCase();
  }

  window.MsspApiClient = {
    getCollections,
    getEpisodes,
    getHealth,
    getMode,
  };
}());
