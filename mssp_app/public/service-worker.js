// Bump this to replace cached shell assets. Unregister the worker or clear site data to recover a bad test worker.
const CACHE_VERSION = "mssp-v83";
const CACHE_PREFIX = "mssp-";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const BASE = new URL(self.registration.scope);

const SHELL_PATHS = [
  "./",
  "./index.html",
  "./site.webmanifest",
  "./css/base.css",
  "./css/layout.css",
  "./css/launch.css",
  "./css/archive.css",
  "./css/library.css",
  "./css/episode-list.css",
  "./css/episode-details.css",
  "./css/filters.css",
  "./css/tooltip.css",
  "./css/responsive.css",
  "./css/utilities.css",
  "./css/player.css",
  "./js/apiClient.js?v=static-first-data",
  "./js/main.js?v=frontend-module-split",
  "./js/archiveStats.js",
  "./js/calendarModal.js",
  "./js/collectionsView.js",
  "./js/dom.js",
  "./js/episodeDetails.js",
  "./js/episodeList.js",
  "./js/filters.js",
  "./js/favoritesStore.js",
  "./js/libraryView.js",
  "./js/player/audioController.js",
  "./js/player/mediaSessionController.js",
  "./js/player/playerState.js",
  "./js/player/playerView.js",
  "./js/player/sourceStatus.js",
  "./js/pwa.js",
  "./js/search.js",
  "./js/sources/publicSources.js",
  "./js/state.js",
  "./js/tooltip.js",
  "./js/utils.js",
  "./assets/covers/anthology-hover.jpg",
  "./assets/covers/anthology.jpg",
  "./assets/covers/new.jpg",
  "./assets/covers/old.jpg",
  "./assets/covers/paytch.jpg",
  "./assets/brand/mssp-mark.png",
  "./assets/icons/archive.svg",
  "./assets/media-session/old-192.jpg",
  "./assets/media-session/old-512.jpg",
  "./android-chrome-192x192.png",
  "./android-chrome-512x512.png",
  "./apple-touch-icon.png",
  "./favicon-16x16.png",
  "./favicon-32x32.png",
  "./favicon.ico",
];

const DATA_PATHS = [
  "./data/collections.json",
  "./data/episodes.json",
  "./data/health.json",
  "./data/sources.public.json",
];

const resolveUrl = (path) => new URL(path, BASE).href;
const SHELL_URLS = new Set(SHELL_PATHS.map(resolveUrl));
const DATA_URLS = new Set(DATA_PATHS.map(resolveUrl));
const NAVIGATION_PATHS = new Set([
  new URL("./", BASE).pathname,
  new URL("./index.html", BASE).pathname,
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PATHS.map(resolveUrl))),
      caches.open(DATA_CACHE).then((cache) => cache.addAll(DATA_PATHS.map(resolveUrl))),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== BASE.origin || !url.href.startsWith(BASE.href)) return;
  if (url.pathname.startsWith(new URL("./api/", BASE).pathname)) return;
  if (request.destination === "audio" || request.destination === "video") return;
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac|mp4|webm)$/i.test(url.pathname)) return;

  if (request.mode === "navigate" && NAVIGATION_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirstNavigation());
    return;
  }

  if (DATA_URLS.has(url.href)) {
    event.respondWith(networkFirstData(request));
    return;
  }

  if (SHELL_URLS.has(url.href)) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function cacheFirstNavigation() {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(resolveUrl("./")) || await cache.match(resolveUrl("./index.html"));
  if (cached) return cached;
  return fetch(resolveUrl("./index.html"));
}

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}
