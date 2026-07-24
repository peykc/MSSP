const RELEASE_ID = "v417";
const CACHE_PREFIX = "mssp-";
const SHELL_CACHE_PREFIX = `${CACHE_PREFIX}shell-`;
const DATA_CACHE_PREFIX = `${CACHE_PREFIX}data-`;
const META_CACHE = `${CACHE_PREFIX}meta`;
const BASE = new URL(self.registration.scope);
const META_STATE_URL = new URL("./__mssp_cache_meta__/state", BASE).href;
const META_CANDIDATE_URL = new URL(`./__mssp_cache_meta__/candidate-${RELEASE_ID}`, BASE).href;
const COMPLETION_URL = new URL("./__mssp_cache_meta__/complete", BASE).href;

const SHELL_PATHS = [
  "./",
  "./index.html",
  "./site.webmanifest",
  "./css/base.css?v=list-unify-a",
  "./css/layout.css?v=a2hs-b",
  "./css/launch.css?v=a2hs-d",
  "./css/archive.css?v=tip-nav-c",
  "./css/sealed-stone.css",
  "./css/library.css?v=archive-iowan-a",
  "./css/episode-list.css?v=views-pending-a",
  "./css/episode-details.css?v=views-rows-b",
  "./css/filters.css",
  "./css/tooltip.css",
  "./css/responsive.css?v=fav-empty-a",
  "./css/utilities.css",
  "./css/player.css?v=ambient-stamp-c",
  "./css/pwa-update.css?v=a2hs-b",
  "./css/patreon-rss.css?v=a2hs-f",
  "./css/transcript.css?v=cover-ambient-g",
  "./css/global-search.css?v=sort-reveal-a",
  "./js/apiClient.js?v=static-first-data",
  "./js/main.js?v=dirty-r2-a",
  "./js/a2hsModal.js?v=a2hs-e",
  "./js/community/communityIdentity.js",
  "./js/community/communityPresence.js?v=poll-cut-a",
  "./js/community/communitySignals.js?v=poll-cut-a",
  "./js/community/viewProgress.js",
  "./js/patreonRssModal.js?v=dirty-r2-a",
  "./js/archiveStats.js",
  "./js/calendarModal.js?v=heatmap-full-labels-a",
  "./js/collectionGlyphs.js",
  "./js/collectionsView.js?v=cal-preview-b",
  "./js/dom.js?v=playback-speed-l",
  "./js/episodeDetails.js?v=poll-cut-a",
  "./js/episodeRow.js?v=poll-cut-a",
  "./js/episodeList.js?v=poll-cut-a",
  "./js/filters.js",
  "./js/favoritesStore.js",
  "./js/fullCalendarModal.js?v=scroll-bottom-b",
  "./js/globalSearch.js?v=sort-reveal-a",
  "./js/sealedStoneModal.js",
  "./js/statsPageView.js",
  "./js/libraryView.js?v=mini-scroll-a",
  "./js/launchSplash.js",
  "./js/player/audioController.js?v=playback-speed-p",
  "./js/player/coverAmbient.js?v=ambient-stamp-c",
  "./js/player/mediaSessionController.js",
  "./js/player/playerState.js",
  "./js/player/playerView.js?v=ambient-stamp-c",
  "./js/player/sourceStatus.js",
  "./js/player/transcriptView.js?v=scroll-hydrate-m",
  "./js/player/transcriptSearch.js?v=search-ops-a",
  "./js/pwa.js?v=pull-overscroll-a",
  "./js/search.js",
  "./js/sources/publicSources.js",
  "./js/sources/patreonRssMatcher.js?v=dirty-r2-a",
  "./js/sources/patreonRssSources.js?v=dirty-r2-a",
  "./js/sources/patreonR2Sources.js?v=dirty-r2-a",
  "./js/state.js",
  "./js/tooltip.js?v=search-no-tip-a",
  "./js/utils.js",
  "./assets/covers/anthology-hover.webp",
  "./assets/covers/anthology.webp",
  "./assets/covers/new.webp",
  "./assets/covers/old.webp",
  "./assets/covers/paytch.webp",
  "./apple-touch-icon.png",
  "./assets/stone.svg",
  "./assets/icons/archive.svg",
  "./assets/icons/hand-from-ground.svg",
  "./assets/icons/hero-cross.svg",
  "./assets/fonts/spectral-italic-400-latin.woff2",
  "./assets/fonts/spectral-normal-400-latin.woff2",
  "./assets/fonts/spectral-normal-500-latin.woff2",
  "./assets/fonts/spectral-normal-600-latin.woff2",
  "./assets/media-session/old-192.jpg",
  "./assets/media-session/old-512.jpg",
  "./android-chrome-192x192.png",
  "./android-chrome-512x512.png",
  "./favicon-16x16.png",
  "./favicon-32x32.png",
  "./favicon.ico",
];

const DATA_PATHS = [
  "./data/collections.json",
  "./data/episodes.json",
  "./data/health.json",
  "./data/sources.public.json",
  "./data/patreon-rss-overrides.json",
];

const resolveUrl = (path) => new URL(path, BASE).href;
const SHELL_URLS = new Set(SHELL_PATHS.map(resolveUrl));
const DATA_URLS = new Set(DATA_PATHS.map(resolveUrl));
const TRANSCRIPT_PATH_PREFIX = new URL("./data/transcripts/", BASE).pathname;
const API_PATH_PREFIX = new URL("./api/", BASE).pathname;
const NAVIGATION_PATHS = new Set([
  new URL("./", BASE).pathname,
  new URL("./index.html", BASE).pathname,
]);

let activeGeneration = null;
let activeGenerationPromise = null;
let hardRefreshPromise = null;

self.addEventListener("install", (event) => {
  event.waitUntil(prepareReleaseGeneration());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateReleaseGeneration().then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data?.type !== "HARD_REFRESH") return;
  const port = event.ports?.[0];
  const task = hardRefreshPromise || hardRefresh();
  hardRefreshPromise = task;
  event.waitUntil(
    task
      .then((generation) => {
        port?.postMessage({ ok: true, generation });
      })
      .catch((error) => {
        port?.postMessage({
          ok: false,
          error: {
            code: error?.code || "HARD_REFRESH_FAILED",
            message: error?.message || String(error),
          },
        });
      })
      .finally(() => {
        if (hardRefreshPromise === task) hardRefreshPromise = null;
      })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== BASE.origin || !url.href.startsWith(BASE.href)) return;
  if (url.pathname.startsWith(API_PATH_PREFIX)) return;
  if (request.destination === "audio" || request.destination === "video") return;
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac|mp4|webm)$/i.test(url.pathname)) return;

  // Snapshot the generation once. A concurrent promotion cannot mix generations in this fetch.
  const generationPromise = getActiveGeneration();

  if (request.mode === "navigate" && NAVIGATION_PATHS.has(url.pathname)) {
    event.respondWith(generationPromise.then((generation) => cacheFirstNavigation(generation)));
    return;
  }

  if (DATA_URLS.has(url.href)) {
    event.respondWith(generationPromise.then((generation) => networkFirstData(request, generation)));
    return;
  }

  if (url.pathname.startsWith(TRANSCRIPT_PATH_PREFIX) && url.pathname.endsWith(".json")) {
    event.respondWith(generationPromise.then((generation) => (
      networkFirstData(request, generation, { cacheOnlyStatus200: true })
    )));
    return;
  }

  if (SHELL_URLS.has(url.href)) {
    event.respondWith(generationPromise.then((generation) => cacheFirst(request, generation)));
  }
});

async function prepareReleaseGeneration() {
  const meta = await caches.open(META_CACHE);
  const existing = await readJsonResponse(await meta.match(META_CANDIDATE_URL));
  if (existing && await isCompleteGeneration(existing)) return existing;

  const generation = createGeneration(`${Date.now()}-${RELEASE_ID}`);
  try {
    await buildGeneration(generation, { bypassHttpCache: true });
    await meta.put(META_CANDIDATE_URL, jsonResponse(generation));
    return generation;
  } catch (error) {
    await deleteGeneration(generation);
    throw error;
  }
}

async function activateReleaseGeneration() {
  const meta = await caches.open(META_CACHE);
  const candidate = await readJsonResponse(await meta.match(META_CANDIDATE_URL));
  if (candidate && await isCompleteGeneration(candidate)) {
    await promoteGeneration(candidate);
    await meta.delete(META_CANDIDATE_URL);
  } else {
    activeGeneration = await loadOrRecoverGeneration();
  }
  await cleanupGenerations();
}

async function hardRefresh() {
  const generation = createGeneration(`${Date.now()}-${randomToken()}`);
  try {
    await buildGeneration(generation, { bypassHttpCache: true });
    await promoteGeneration(generation);
    await cleanupGenerations();
    return generation;
  } catch (error) {
    await deleteGeneration(generation);
    throw error;
  }
}

function createGeneration(id) {
  return {
    id: `g${id}`,
    shellCache: `${SHELL_CACHE_PREFIX}g${id}`,
    dataCache: `${DATA_CACHE_PREFIX}g${id}`,
    createdAt: Date.now(),
  };
}

async function buildGeneration(generation, { bypassHttpCache = false } = {}) {
  const shellCache = await caches.open(generation.shellCache);
  const dataCache = await caches.open(generation.dataCache);

  await settleOrThrow([
    populateCache(shellCache, SHELL_PATHS.map(resolveUrl), bypassHttpCache),
    populateCache(dataCache, DATA_PATHS.map(resolveUrl), bypassHttpCache),
  ]);

  await settleOrThrow([
    verifyCache(shellCache, SHELL_PATHS.map(resolveUrl)),
    verifyCache(dataCache, DATA_PATHS.map(resolveUrl)),
  ]);

  const marker = jsonResponse(generation);
  await Promise.all([
    shellCache.put(COMPLETION_URL, marker.clone()),
    dataCache.put(COMPLETION_URL, marker),
  ]);
}

async function populateCache(cache, urls, bypassHttpCache) {
  await settleOrThrow(urls.map(async (url) => {
    const request = new Request(url, bypassHttpCache ? { cache: "no-store" } : undefined);
    const response = await fetch(request);
    if (!response.ok) {
      const error = new Error(`Could not refresh ${new URL(url).pathname} (${response.status}).`);
      error.code = "CACHE_FETCH_FAILED";
      throw error;
    }
    await cache.put(request, response);
  }));
}

async function settleOrThrow(promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function verifyCache(cache, urls) {
  const missing = [];
  for (const url of urls) {
    if (!await cache.match(url)) missing.push(new URL(url).pathname);
  }
  if (!missing.length) return;
  const error = new Error(`Cache verification failed: ${missing.join(", ")}`);
  error.code = "CACHE_VERIFICATION_FAILED";
  throw error;
}

async function promoteGeneration(generation) {
  if (!await isCompleteGeneration(generation)) {
    const error = new Error("Cannot promote an incomplete cache generation.");
    error.code = "INCOMPLETE_GENERATION";
    throw error;
  }

  const current = await getActiveGeneration();
  const state = {
    active: generation,
    previous: current && current.id !== generation.id ? current : null,
  };
  const meta = await caches.open(META_CACHE);
  await meta.put(META_STATE_URL, jsonResponse(state));
  activeGeneration = generation;
  activeGenerationPromise = Promise.resolve(generation);
}

async function getActiveGeneration() {
  if (activeGeneration) return activeGeneration;
  if (!activeGenerationPromise) {
    activeGenerationPromise = loadOrRecoverGeneration().then((generation) => {
      activeGeneration = generation;
      return generation;
    });
  }
  return activeGenerationPromise;
}

async function loadOrRecoverGeneration() {
  const meta = await caches.open(META_CACHE);
  const state = await readJsonResponse(await meta.match(META_STATE_URL));
  if (state?.active && await isCompleteGeneration(state.active)) return state.active;

  const recovered = await findNewestCompleteGeneration();
  if (!recovered) return null;
  await meta.put(META_STATE_URL, jsonResponse({ active: recovered, previous: null }));
  return recovered;
}

async function findNewestCompleteGeneration() {
  const keys = await caches.keys();
  const shellNames = keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX));
  const candidates = [];

  for (const shellCache of shellNames) {
    const shell = await caches.open(shellCache);
    const descriptor = await readJsonResponse(await shell.match(COMPLETION_URL));
    if (!descriptor || descriptor.shellCache !== shellCache) continue;
    if (await isCompleteGeneration(descriptor)) candidates.push(descriptor);
  }

  candidates.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return candidates[0] || null;
}

async function isCompleteGeneration(generation) {
  if (!isGenerationDescriptor(generation)) return false;
  const keys = new Set(await caches.keys());
  if (!keys.has(generation.shellCache) || !keys.has(generation.dataCache)) return false;

  const [shell, data] = await Promise.all([
    caches.open(generation.shellCache),
    caches.open(generation.dataCache),
  ]);
  const [shellMarker, dataMarker] = await Promise.all([
    readJsonResponse(await shell.match(COMPLETION_URL)),
    readJsonResponse(await data.match(COMPLETION_URL)),
  ]);
  return shellMarker?.id === generation.id && dataMarker?.id === generation.id;
}

function isGenerationDescriptor(value) {
  return Boolean(
    value
    && typeof value.id === "string"
    && typeof value.shellCache === "string"
    && typeof value.dataCache === "string"
    && value.shellCache.startsWith(SHELL_CACHE_PREFIX)
    && value.dataCache.startsWith(DATA_CACHE_PREFIX)
  );
}

async function cleanupGenerations() {
  const meta = await caches.open(META_CACHE);
  const state = await readJsonResponse(await meta.match(META_STATE_URL));
  const keep = new Set([META_CACHE]);
  for (const generation of [state?.active, state?.previous]) {
    if (!isGenerationDescriptor(generation)) continue;
    keep.add(generation.shellCache);
    keep.add(generation.dataCache);
  }

  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => key.startsWith(CACHE_PREFIX) && !keep.has(key))
    .map((key) => caches.delete(key).catch(() => false)));
}

async function deleteGeneration(generation) {
  if (!isGenerationDescriptor(generation)) return;
  await Promise.all([
    caches.delete(generation.shellCache),
    caches.delete(generation.dataCache),
  ]);
}

async function cacheFirst(request, generation) {
  if (!generation) return fetch(request);
  const cache = await caches.open(generation.shellCache);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function cacheFirstNavigation(generation) {
  if (!generation) return fetch(resolveUrl("./index.html"));
  const cache = await caches.open(generation.shellCache);
  const cached = await cache.match(resolveUrl("./")) || await cache.match(resolveUrl("./index.html"));
  if (cached) return cached;
  return fetch(resolveUrl("./index.html"));
}

async function networkFirstData(request, generation, { cacheOnlyStatus200 = false } = {}) {
  const cache = generation ? await caches.open(generation.dataCache) : null;
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (cache && (cacheOnlyStatus200 ? response.status === 200 : response.ok)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache?.match(request);
    if (cached) return cached;
    throw error;
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function readJsonResponse(response) {
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function randomToken() {
  if (self.crypto?.getRandomValues) {
    const values = new Uint32Array(2);
    self.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36)).join("");
  }
  return Math.random().toString(36).slice(2, 10);
}
