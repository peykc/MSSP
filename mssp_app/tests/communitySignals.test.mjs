import assert from "node:assert/strict";
import test from "node:test";

import {
  createCommunitySignals,
  formatCommunityCount,
  formatViewSignal,
} from "../public/js/community/communitySignals.js";

const API_BASE = "https://msspsignal.pkcollection.net";
const CLIENT_ID = "7f52ca32-8f4c-4f6b-917e-13b9933a61aa";

test("count loading deduplicates keys, splits at 20, and merges endpoints independently", async () => {
  const keys = Array.from({ length: 45 }, (_, index) => `episode-${index}`);
  const requests = [];
  const signals = createSignals({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 3 });
      }
      const episodeKeys = parsed.searchParams.getAll("episode");
      const field = parsed.pathname.includes("stars") ? "stars" : "views";
      return Response.json({
        episodes: Object.fromEntries(episodeKeys.map((key, index) => [key, { [field]: index + 1 }])),
      });
    },
  });
  signals.setKnownEpisodeKeys(keys);
  await signals.loadCountsForEpisodes([...keys, keys[0]]);

  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ options }) => options.cache === "no-store" && options.credentials === "omit"));
  assert.ok(requests.every(({ url }) => {
    const parsed = new URL(url);
    return parsed.pathname.endsWith("/presence/online") || parsed.searchParams.getAll("episode").length <= 20;
  }));
  assert.deepEqual(signals.getEpisodeSignals(keys[0]), { stars: 1, views: 1 });
});

test("archive tracking replaces the virtual window instead of accumulating keys", async () => {
  const requests = [];
  const signals = createSignals({
    archiveDebounceMs: 5,
    fetchImpl: async (url) => {
      requests.push(String(url));
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 0 });
      }
      const field = parsed.pathname.includes("stars") ? "stars" : "views";
      return Response.json({ episodes: Object.fromEntries(parsed.searchParams.getAll("episode").map((key) => [key, { [field]: 0 }])) });
    },
  });
  signals.setKnownEpisodeKeys(["a", "b", "c"]);
  signals.setTrackedEpisodeKeys("archive", ["a", "b"]);
  signals.setTrackedEpisodeKeys("archive", ["c"]);
  await wait(20);

  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => new URL(url).searchParams.getAll("episode").join() === "c"));
});

test("favorite retry does not apply a second optimistic increment", async () => {
  const storage = memoryStorage();
  let toggleAttempts = 0;
  const signals = createSignals({
    storage,
    retryDelaysMs: [5],
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 0 });
      }
      if (parsed.pathname.endsWith("/visitors/record")) {
        return Response.json({ counted: false, total: 1 });
      }
      if (parsed.pathname.endsWith("/stars/toggle")) {
        toggleAttempts += 1;
        if (toggleAttempts === 1) throw new Error("offline");
        return Response.json({ episodeKey: "paytch", favorite: true, count: 11 });
      }
      const field = parsed.pathname.includes("stars") ? "stars" : "views";
      return Response.json({ episodes: { paytch: { [field]: field === "stars" ? 10 : 0 } } });
    },
  });
  signals.setKnownEpisodeKeys(["paytch"]);
  await signals.loadCountsForEpisodes(["paytch"]);
  signals.start();
  signals.setFavorite("paytch", { previousFavorite: false, favorite: true });
  assert.equal(signals.getEpisodeSignals("paytch").stars, 11);
  await wait(25);
  assert.equal(toggleAttempts, 2);
  assert.equal(signals.getEpisodeSignals("paytch").stars, 11);
  assert.deepEqual(JSON.parse(storage.getItem("mssp:community-favorite-outbox")), {});
  signals.stop();
});

test("outbox drops unknown and malformed entries after catalog validation", () => {
  const storage = memoryStorage({
    "mssp:community-favorite-outbox": JSON.stringify({ known: true, unknown: false, malformed: "yes" }),
  });
  const signals = createSignals({ storage, fetchImpl: async () => Response.json({ episodes: {} }) });
  signals.setKnownEpisodeKeys(["known"]);
  assert.deepEqual(JSON.parse(storage.getItem("mssp:community-favorite-outbox")), { known: true });
});

test("outbox is capped at one pending state for at most 1,000 episodes", () => {
  const entries = Object.fromEntries(Array.from({ length: 1005 }, (_, index) => [`episode-${index}`, index % 2 === 0]));
  const storage = memoryStorage({
    "mssp:community-favorite-outbox": JSON.stringify(entries),
  });
  const signals = createSignals({ storage, fetchImpl: async () => Response.json({ episodes: {} }) });
  signals.setKnownEpisodeKeys(Object.keys(entries));
  assert.equal(Object.keys(JSON.parse(storage.getItem("mssp:community-favorite-outbox"))).length, 1000);
});

test("repeated background failures suspend polling until an online resume", async () => {
  const windowRef = new EventTarget();
  windowRef.setTimeout = setTimeout;
  windowRef.clearTimeout = clearTimeout;
  windowRef.setInterval = setInterval;
  windowRef.clearInterval = clearInterval;
  let requests = 0;
  const signals = createSignals({
    windowRef,
    archiveDebounceMs: 1,
    refreshIntervalMs: 5,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("offline");
    },
  });
  signals.setKnownEpisodeKeys(["episode"]);
  signals.setTrackedEpisodeKeys("archive", ["episode"]);
  signals.start();
  await wait(40);
  const suspendedAt = requests;
  await wait(25);
  assert.equal(requests, suspendedAt);
  windowRef.dispatchEvent(new Event("online"));
  await wait(10);
  assert.ok(requests > suspendedAt);
  signals.stop();
});

test("PAYTCH mutations send only the permitted privacy fields", async () => {
  const bodies = [];
  const requestOptions = [];
  const signals = createSignals({
    retryDelaysMs: [1000],
    fetchImpl: async (url, options) => {
      if (options?.body) bodies.push(JSON.parse(options.body));
      if (options?.body) requestOptions.push(options);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/stars/toggle")) {
        return Response.json({ episodeKey: "paytch-key", favorite: true, count: 1 });
      }
      if (parsed.pathname.endsWith("/presence/heartbeat")) {
        return Response.json({ online: 1 });
      }
      if (parsed.pathname.endsWith("/views/record")) {
        return Response.json({ episodeKey: "paytch-key", counted: true, views: 1 });
      }
      if (parsed.pathname.endsWith("/visitors/record")) {
        return Response.json({ counted: true, total: 1 });
      }
      return Response.json({ episodes: {} });
    },
  });
  signals.setKnownEpisodeKeys(["paytch-key"]);
  signals.start();
  signals.setFavorite("paytch-key", { previousFavorite: false, favorite: true });
  await signals.sendOnlineHeartbeat({ online: true, keepalive: true });
  await signals.recordView("paytch-key");
  await wait(5);
  signals.stop();

  assert.deepEqual(Object.keys(bodies.find((body) => "favorite" in body)).sort(), ["clientId", "episodeKey", "favorite"]);
  assert.deepEqual(Object.keys(bodies.find((body) => "online" in body)).sort(), ["clientId", "online"]);
  assert.deepEqual(Object.keys(bodies.find((body) => "episodeKey" in body && !("favorite" in body))).sort(), ["clientId", "episodeKey"]);
  assert.equal(JSON.stringify(bodies).includes("rss"), false);
  assert.equal(JSON.stringify(bodies).includes("audio"), false);
  assert.equal(requestOptions.find((options) => JSON.parse(options.body).online === true)?.keepalive, false);
});

test("online count subscribers receive global presence updates", async () => {
  const signals = createSignals({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 7 });
      }
      if (parsed.pathname.endsWith("/visitors/record")) {
        return Response.json({ counted: true, total: 42 });
      }
      if (parsed.pathname.endsWith("/visitors/total")) {
        return Response.json({ total: 42 });
      }
      return Response.json({ episodes: {} });
    },
  });
  const values = [];
  signals.subscribeOnline((count) => values.push(count));
  signals.start();
  await wait(10);
  assert.deepEqual(values, [null, 7]);
  signals.stop();
});

test("hidden tabs skip polling unless audio is playing", async () => {
  const documentRef = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  const windowRef = new EventTarget();
  windowRef.setTimeout = setTimeout;
  windowRef.clearTimeout = clearTimeout;
  windowRef.setInterval = setInterval;
  windowRef.clearInterval = clearInterval;
  const requests = [];
  const signals = createSignals({
    documentRef,
    windowRef,
    refreshIntervalMs: 5,
    fetchImpl: async (url) => {
      requests.push(String(url));
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 1 });
      }
      if (parsed.pathname.endsWith("/visitors/record")) {
        return Response.json({ counted: true, total: 1 });
      }
      if (parsed.pathname.endsWith("/visitors/total")) {
        return Response.json({ total: 1 });
      }
      const field = parsed.pathname.includes("stars") ? "stars" : "views";
      return Response.json({
        episodes: Object.fromEntries(parsed.searchParams.getAll("episode").map((key) => [key, { [field]: 0 }])),
      });
    },
  });
  signals.setKnownEpisodeKeys(["episode"]);
  signals.setTrackedEpisodeKeys("archive", ["episode"]);
  signals.start();
  await wait(25);
  const baseline = requests.length;
  await wait(20);
  assert.equal(requests.length, baseline);

  signals.setListeningActive(true);
  await wait(20);
  assert.ok(requests.length > baseline);
  assert.ok(requests.some((url) => url.includes("/stars/counts") || url.includes("/views/counts") || url.includes("/presence/online")));
  signals.stop();
});

test("visitor record updates the amusement-park total once per client", async () => {
  const bodies = [];
  const visitorValues = [];
  const signals = createSignals({
    fetchImpl: async (url, options) => {
      if (options?.body) bodies.push(JSON.parse(options.body));
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/online")) {
        return Response.json({ online: 0 });
      }
      if (parsed.pathname.endsWith("/visitors/record")) {
        return Response.json({ counted: true, total: 19 });
      }
      return Response.json({ episodes: {} });
    },
  });
  signals.subscribeVisitors((total) => visitorValues.push(total));
  signals.start();
  await wait(10);
  assert.deepEqual(visitorValues, [null, 19]);
  assert.deepEqual(bodies.find((body) => Object.keys(body).join() === "clientId"), { clientId: CLIENT_ID });
  assert.equal(signals.getVisitorTotal(), 19);
  signals.stop();
});

test("community formatting keeps view counts readable", () => {
  assert.equal(formatCommunityCount(null), "—");
  assert.equal(formatCommunityCount(1200, { compact: true }), "1.2K");
  assert.equal(formatViewSignal(null), "—");
  assert.equal(formatViewSignal(0), "0");
  assert.equal(formatViewSignal(1), "1");
  assert.equal(formatViewSignal(1200, { compact: true }), "1.2K");
});

function createSignals(overrides = {}) {
  return createCommunitySignals({
    apiBase: API_BASE,
    getClientId: () => CLIENT_ID,
    storage: memoryStorage(),
    windowRef: new EventTarget(),
    documentRef: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    refreshIntervalMs: 60_000,
    ...overrides,
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
