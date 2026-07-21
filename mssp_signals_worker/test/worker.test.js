import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, { hashClientId } from "../src/index.js";
import { EPISODE_KEYS } from "../src/generated/episodeCatalog.js";
import { GLOBAL_PRESENCE_ROOM, PresenceRoom, PRESENCE_TTL_MS } from "../src/presenceRoom.js";

const API_ORIGIN = "https://peykc.github.io";
const API_BASE = "https://mssp-signals.example.workers.dev";
const CLIENT_ONE = "7f52ca32-8f4c-4f6b-917e-13b9933a61aa";
const CLIENT_TWO = "bddab51d-b7fa-4bb5-b7df-fc090d38d15f";
const SALT = "test-only-salt";
const MOCK_PEAK_AT_MS = 1_700_000_000_000;
const [EPISODE_ONE, EPISODE_TWO, ...OTHER_EPISODES] = EPISODE_KEYS;

test("health and preflight use strict CORS and no-store JSON headers", async () => {
  const env = createEnv();
  const health = await callWorker(env, "/v1/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "mssp-signals", version: 1 });
  assertPublicHeaders(health, API_ORIGIN);

  const preflight = await callWorker(env, "/v1/stars/toggle", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assertPublicHeaders(preflight, API_ORIGIN);

  const localhost = await callWorker(env, "/v1/health", {}, "http://localhost:5177");
  assert.equal(localhost.status, 200);
  assert.equal(localhost.headers.get("Access-Control-Allow-Origin"), "http://localhost:5177");
});

test("errors retain no-store JSON headers without granting disallowed CORS", async () => {
  const env = createEnv();
  const denied = await callWorker(env, "/v1/health", {}, "https://example.com");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assertPublicHeaders(denied);

  const missing = await callWorker(env, "/v1/missing");
  assert.equal(missing.status, 404);
  assertPublicHeaders(missing, API_ORIGIN);

  const method = await callWorker(env, "/v1/health", { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET, OPTIONS");
  assertPublicHeaders(method, API_ORIGIN);
});

test("JSON content type is required only on body routes", async () => {
  const env = createEnv();
  const counts = await callWorker(env, `/v1/views/counts?episode=${encodeURIComponent(EPISODE_ONE)}`);
  assert.equal(counts.status, 200);

  const toggle = await callWorker(env, "/v1/stars/toggle", {
    method: "POST",
    body: JSON.stringify({ clientId: CLIENT_ONE, episodeKey: EPISODE_ONE, favorite: true }),
  });
  assert.equal(toggle.status, 415);
});

test("body validation rejects malformed, oversized, unexpected, and invalid values", async () => {
  const env = createEnv();
  const malformed = await postJson(env, "/v1/stars/toggle", "{");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");

  const unexpected = await postJson(env, "/v1/stars/toggle", {
    clientId: CLIENT_ONE,
    episodeKey: EPISODE_ONE,
    favorite: true,
    extra: true,
  });
  assert.equal(unexpected.status, 400);

  const invalidUuid = await postJson(env, "/v1/stars/toggle", {
    clientId: "not-a-uuid",
    episodeKey: EPISODE_ONE,
    favorite: true,
  });
  assert.equal(invalidUuid.status, 400);
  assert.equal((await invalidUuid.json()).error.code, "INVALID_CLIENT_ID");

  const unknownEpisode = await postJson(env, "/v1/stars/toggle", {
    clientId: CLIENT_ONE,
    episodeKey: "mssp-not-real",
    favorite: true,
  });
  assert.equal(unknownEpisode.status, 400);
  assert.equal((await unknownEpisode.json()).error.code, "UNKNOWN_EPISODE");

  const oversized = await callWorker(env, "/v1/stars/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(1100) }),
  });
  assert.equal(oversized.status, 413);
});

test("view records are idempotent and counts reconcile from the final batch query", async () => {
  const env = createEnv();
  const record = (clientId) => postJson(env, "/v1/views/record", {
    clientId,
    episodeKey: EPISODE_ONE,
  });

  assert.deepEqual(await (await record(CLIENT_ONE)).json(), {
    episodeKey: EPISODE_ONE,
    counted: true,
    views: 1,
  });
  assert.deepEqual(await (await record(CLIENT_ONE)).json(), {
    episodeKey: EPISODE_ONE,
    counted: false,
    views: 1,
  });
  assert.deepEqual(await (await record(CLIENT_TWO)).json(), {
    episodeKey: EPISODE_ONE,
    counted: true,
    views: 2,
  });

  const counts = new URLSearchParams({ episode: EPISODE_ONE });
  const response = await callWorker(env, `/v1/views/counts?${counts}`);
  assert.deepEqual(await response.json(), { episodes: { [EPISODE_ONE]: { views: 2 } } });
});

test("view writes fail before mutation when the D1 catalog is not seeded", async () => {
  const env = createEnv();
  env.DB.catalog.delete(EPISODE_ONE);
  const response = await postJson(env, "/v1/views/record", {
    clientId: CLIENT_ONE,
    episodeKey: EPISODE_ONE,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "CATALOG_NOT_SEEDED");
  assert.equal(env.DB.viewEdges.size, 0);
});

test("count queries allow repeated parameters, dedupe values, and reject unsupported input", async () => {
  const env = createEnv();
  const repeated = new URLSearchParams();
  repeated.append("episode", EPISODE_ONE);
  repeated.append("episode", EPISODE_ONE);
  repeated.append("episode", EPISODE_TWO);
  const response = await callWorker(env, `/v1/views/counts?${repeated}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys((await response.json()).episodes), [EPISODE_ONE, EPISODE_TWO]);

  const unsupported = await callWorker(env, `/v1/views/counts?episodes=${encodeURIComponent(EPISODE_ONE)}`);
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_QUERY_PARAMETER");

  const tooMany = new URLSearchParams();
  [EPISODE_ONE, EPISODE_TWO, ...OTHER_EPISODES.slice(0, 19)]
    .forEach((episodeKey) => tooMany.append("episode", episodeKey));
  const oversizedBatch = await callWorker(env, `/v1/views/counts?${tooMany}`);
  assert.equal(oversizedBatch.status, 400);
  assert.equal((await oversizedBatch.json()).error.code, "BATCH_TOO_LARGE");
});

test("client hashing is deterministic and raw IDs never enter persistent bindings", async () => {
  const expected = await hashClientId(CLIENT_ONE, SALT);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(await hashClientId(CLIENT_ONE, SALT), expected);
  assert.notEqual(await hashClientId(CLIENT_ONE, `${SALT}-other`), expected);

  const env = createEnv();
  const response = await postJson(env, "/v1/stars/toggle", {
    clientId: CLIENT_ONE,
    episodeKey: EPISODE_ONE,
    favorite: true,
  });
  assert.equal(response.status, 200);
  assert.equal(env.DB.counts.get(EPISODE_ONE), 1);
  assert.equal(JSON.stringify(env.DB.boundValues).includes(CLIENT_ONE), false);
  assert.equal(env.DB.boundValues.some((value) => value === expected), true);

  await postJson(env, "/v1/presence/heartbeat", {
    clientId: CLIENT_ONE,
    online: true,
  });
  assert.equal(JSON.stringify(env.PRESENCE.payloads).includes(CLIENT_ONE), false);
  assert.equal(env.PRESENCE.payloads[0].clientHash, expected);
  assert.equal(env.PRESENCE.requestedNames.at(-1), GLOBAL_PRESENCE_ROOM);
});

test("favorite mutations are idempotent and counts reconcile from the final batch query", async () => {
  const env = createEnv();
  const toggle = (clientId, favorite) => postJson(env, "/v1/stars/toggle", {
    clientId,
    episodeKey: EPISODE_ONE,
    favorite,
  });

  assert.equal((await (await toggle(CLIENT_ONE, true)).json()).count, 1);
  assert.equal((await (await toggle(CLIENT_ONE, true)).json()).count, 1);
  assert.equal((await (await toggle(CLIENT_TWO, true)).json()).count, 2);
  assert.equal((await (await toggle(CLIENT_ONE, false)).json()).count, 1);
  assert.equal((await (await toggle(CLIENT_ONE, false)).json()).count, 1);
  assert.equal((await (await toggle(CLIENT_TWO, false)).json()).count, 0);
  assert.equal((await (await toggle(CLIENT_TWO, false)).json()).count, 0);

  const counts = new URLSearchParams({ episode: EPISODE_ONE });
  const response = await callWorker(env, `/v1/stars/counts?${counts}`);
  assert.deepEqual(await response.json(), { episodes: { [EPISODE_ONE]: { stars: 0 } } });
});

test("favorite writes fail before mutation when the D1 catalog is not seeded", async () => {
  const env = createEnv();
  env.DB.catalog.delete(EPISODE_ONE);
  const response = await postJson(env, "/v1/stars/toggle", {
    clientId: CLIENT_ONE,
    episodeKey: EPISODE_ONE,
    favorite: true,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "CATALOG_NOT_SEEDED");
  assert.equal(env.DB.edges.size, 0);
});

test("global online count reads from the shared presence room", async () => {
  const env = createEnv();
  env.PRESENCE.rooms.set(GLOBAL_PRESENCE_ROOM, new Map([["hash", true]]));
  const response = await callWorker(env, "/v1/presence/online");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    online: 1,
    peak: 1,
    peakAt: new Date(MOCK_PEAK_AT_MS).toISOString(),
  });
  assert.deepEqual(env.PRESENCE.requestedNames, [GLOBAL_PRESENCE_ROOM]);
});

test("presence peaks route returns the record and daily series without query support", async () => {
  const env = createEnv();
  env.PRESENCE.rooms.set(GLOBAL_PRESENCE_ROOM, new Map([["hash", true], ["hash-two", true]]));
  const response = await callWorker(env, "/v1/presence/peaks");
  assert.equal(response.status, 200);
  const expectedPeakAt = new Date(MOCK_PEAK_AT_MS).toISOString();
  assert.deepEqual(await response.json(), {
    peak: 2,
    peakAt: expectedPeakAt,
    days: [{ day: "2023-11-14", peak: 2, peakAt: expectedPeakAt }],
  });
  assertPublicHeaders(response, API_ORIGIN);

  const unsupported = await callWorker(env, "/v1/presence/peaks?days=7");
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_QUERY_PARAMETER");
});

test("PresenceRoom dedupes clients, clears stops, and expires stale online users", async () => {
  const sql = new MockSqlStorage();
  const room = new PresenceRoom({
    storage: { sql },
    blockConcurrencyWhile(callback) { return Promise.resolve().then(callback); },
  });
  const clientHash = await hashClientId(CLIENT_ONE, SALT);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal((await roomHeartbeat(room, clientHash, true)).online, 1);
    assert.equal((await roomHeartbeat(room, clientHash, true)).online, 1);
    now += PRESENCE_TTL_MS - 1;
    assert.equal((await roomCount(room)).online, 1);
    now += 1;
    assert.equal((await roomCount(room)).online, 0);
    assert.equal((await roomHeartbeat(room, clientHash, true)).online, 1);
    assert.equal((await roomHeartbeat(room, clientHash, false)).online, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("PresenceRoom records the all-time peak and keeps it after clients leave", async () => {
  const sql = new MockSqlStorage();
  const roomState = {
    storage: { sql },
    blockConcurrencyWhile(callback) { return Promise.resolve().then(callback); },
  };
  const room = new PresenceRoom(roomState);
  const hashOne = await hashClientId(CLIENT_ONE, SALT);
  const hashTwo = await hashClientId(CLIENT_TWO, SALT);
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    assert.deepEqual(await roomHeartbeat(room, hashOne, true), {
      online: 1, peak: 1, peakAt: 2_000_000,
    });
    now += 1_000;
    assert.deepEqual(await roomHeartbeat(room, hashTwo, true), {
      online: 2, peak: 2, peakAt: 2_001_000,
    });
    now += 1_000;
    assert.deepEqual(await roomHeartbeat(room, hashTwo, false), {
      online: 1, peak: 2, peakAt: 2_001_000,
    });
    now += PRESENCE_TTL_MS;
    assert.deepEqual(await roomCount(room), {
      online: 0, peak: 2, peakAt: 2_001_000,
    });
    assert.deepEqual(await roomHeartbeat(room, hashOne, true), {
      online: 1, peak: 2, peakAt: 2_001_000,
    });

    const revived = new PresenceRoom(roomState);
    assert.deepEqual(await roomCount(revived), {
      online: 1, peak: 2, peakAt: 2_001_000,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("PresenceRoom tracks a separate peak for each UTC day", async () => {
  const sql = new MockSqlStorage();
  const roomState = {
    storage: { sql },
    blockConcurrencyWhile(callback) { return Promise.resolve().then(callback); },
  };
  const room = new PresenceRoom(roomState);
  const hashOne = await hashClientId(CLIENT_ONE, SALT);
  const hashTwo = await hashClientId(CLIENT_TWO, SALT);
  const dayOnePeakAt = Date.UTC(2026, 6, 20, 23, 1, 0);
  const dayThreeAt = Date.UTC(2026, 6, 22, 23, 1, 0);
  const originalNow = Date.now;
  let now = Date.UTC(2026, 6, 20, 23, 0, 0);
  Date.now = () => now;
  try {
    await roomHeartbeat(room, hashOne, true);
    now = dayOnePeakAt;
    await roomHeartbeat(room, hashTwo, true);
    now = dayThreeAt;
    await roomHeartbeat(room, hashOne, true);
    assert.deepEqual(await roomPeaks(room), {
      peak: 2,
      peakAt: dayOnePeakAt,
      days: [
        { day: "2026-07-20", peak: 2, peakAt: dayOnePeakAt },
        { day: "2026-07-22", peak: 1, peakAt: dayThreeAt },
      ],
    });
  } finally {
    Date.now = originalNow;
  }
});

test("PresenceRoom seeds the daily series from a pre-daily all-time record", async () => {
  const sql = new MockSqlStorage();
  const recordAt = Date.UTC(2026, 6, 21, 0, 12, 48);
  sql.peak = { online: 8, at: recordAt };
  const room = new PresenceRoom({
    storage: { sql },
    blockConcurrencyWhile(callback) { return Promise.resolve().then(callback); },
  });
  assert.deepEqual(await roomPeaks(room), {
    peak: 8,
    peakAt: recordAt,
    days: [{ day: "2026-07-21", peak: 8, peakAt: recordAt }],
  });
});

test("D1 migrations contain idempotent trigger-maintained favorite and view counts", async () => {
  const initial = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  const views = await readFile(new URL("../migrations/0002_views.sql", import.meta.url), "utf8");
  assert.match(initial, /PRIMARY KEY \(episode_key, client_hash\)/);
  assert.match(initial, /CREATE TRIGGER IF NOT EXISTS favorite_edges_after_insert/);
  assert.match(initial, /CREATE TRIGGER IF NOT EXISTS favorite_edges_after_delete/);
  assert.match(initial, /MAX\(count - 1, 0\)/);
  assert.match(views, /CREATE TRIGGER IF NOT EXISTS view_edges_after_insert/);
});

function createEnv({ environment = "production" } = {}) {
  return {
    CLIENT_HASH_SALT: SALT,
    ENVIRONMENT: environment,
    DB: new MockD1(),
    PRESENCE: new MockPresenceNamespace(),
  };
}

function callWorker(env, path, init = {}, origin = API_ORIGIN) {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  return worker.fetch(new Request(`${API_BASE}${path}`, { ...init, headers }), env);
}

function postJson(env, path, value) {
  return callWorker(env, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

function assertPublicHeaders(response, allowedOrigin) {
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Origin");
  if (allowedOrigin) assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
}

async function roomHeartbeat(room, clientHash, online) {
  const response = await room.fetch(new Request("https://presence.internal/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientHash, online }),
  }));
  return response.json();
}

async function roomCount(room) {
  const response = await room.fetch(new Request("https://presence.internal/count"));
  return response.json();
}

async function roomPeaks(room) {
  const response = await room.fetch(new Request("https://presence.internal/peaks"));
  return response.json();
}

class MockD1 {
  constructor() {
    this.catalog = new Set(EPISODE_KEYS);
    this.edges = new Set();
    this.viewEdges = new Set();
    this.counts = new Map();
    this.viewCounts = new Map();
    this.boundValues = [];
  }

  prepare(sql) {
    return new MockD1Statement(this, sql);
  }

  async batch(statements) {
    return statements.map((statement) => {
      const [episodeKey, clientHash] = statement.values;
      if (statement.sql.startsWith("INSERT OR IGNORE INTO favorite_edges")) {
        const edge = `${episodeKey}\u0000${clientHash}`;
        if (!this.edges.has(edge)) {
          this.edges.add(edge);
          this.counts.set(episodeKey, (this.counts.get(episodeKey) || 0) + 1);
        }
        return { success: true, meta: { changes: this.edges.has(edge) ? 1 : 0 }, results: [] };
      }
      if (statement.sql.startsWith("INSERT OR IGNORE INTO view_edges")) {
        const edge = `${episodeKey}\u0000${clientHash}`;
        const inserted = !this.viewEdges.has(edge);
        if (inserted) {
          this.viewEdges.add(edge);
          this.viewCounts.set(episodeKey, (this.viewCounts.get(episodeKey) || 0) + 1);
        }
        return { success: true, meta: { changes: inserted ? 1 : 0 }, results: [] };
      }
      if (statement.sql.startsWith("DELETE FROM favorite_edges")) {
        const edge = `${episodeKey}\u0000${clientHash}`;
        if (this.edges.delete(edge)) {
          this.counts.set(episodeKey, Math.max((this.counts.get(episodeKey) || 0) - 1, 0));
        }
        return { success: true, results: [] };
      }
      if (statement.sql.startsWith("SELECT COALESCE((SELECT count FROM favorite_counts")) {
        return { success: true, results: [{ count: this.counts.get(episodeKey) || 0 }] };
      }
      if (statement.sql.startsWith("SELECT COALESCE((SELECT count FROM view_counts")) {
        return { success: true, results: [{ count: this.viewCounts.get(episodeKey) || 0 }] };
      }
      throw new Error("Unexpected batch statement");
    });
  }
}

class MockD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    this.db.boundValues.push(...values);
    return this;
  }

  async all() {
    if (this.sql.startsWith("SELECT episode_key FROM episode_catalog")) {
      return { results: this.values.filter((key) => this.db.catalog.has(key)).map((episode_key) => ({ episode_key })) };
    }
    if (this.sql.startsWith("SELECT episode_key, count FROM favorite_counts")) {
      return {
        results: this.values
          .filter((key) => this.db.counts.has(key))
          .map((episode_key) => ({ episode_key, count: this.db.counts.get(episode_key) })),
      };
    }
    if (this.sql.startsWith("SELECT episode_key, count FROM view_counts")) {
      return {
        results: this.values
          .filter((key) => this.db.viewCounts.has(key))
          .map((episode_key) => ({ episode_key, count: this.db.viewCounts.get(episode_key) })),
      };
    }
    throw new Error("Unexpected D1 query");
  }
}

class MockPresenceNamespace {
  rooms = new Map();
  peaks = new Map();
  failedNames = new Set();
  requestedNames = [];
  payloads = [];

  getByName(name) {
    this.requestedNames.push(name);
    return {
      fetch: async (request) => {
        if (this.failedNames.has(name)) throw new Error("room unavailable");
        const room = this.rooms.get(name) || new Map();
        this.rooms.set(name, room);
        const url = new URL(request.url);
        if (url.pathname === "/heartbeat") {
          const payload = await request.json();
          this.payloads.push(payload);
          if (payload.online) room.set(payload.clientHash, true);
          else room.delete(payload.clientHash);
        }
        const peak = Math.max(this.peaks.get(name) || 0, room.size);
        this.peaks.set(name, peak);
        const peakAt = peak > 0 ? MOCK_PEAK_AT_MS : null;
        if (url.pathname === "/peaks") {
          return Response.json({
            peak,
            peakAt,
            days: peak > 0 ? [{ day: "2023-11-14", peak, peakAt }] : [],
          });
        }
        return Response.json({ online: room.size, peak, peakAt });
      },
    };
  }
}

class MockSqlStorage {
  clients = new Map();
  peak = { online: 0, at: null };
  dailyPeaks = new Map();

  exec(sql, ...values) {
    const normalized = sql.trim();
    if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("CREATE INDEX")) return cursor([]);
    if (normalized.startsWith("UPDATE presence_stats")) {
      const [online, at, threshold] = values;
      if (this.peak.online < threshold) this.peak = { online, at };
      return cursor([]);
    }
    if (normalized.startsWith("SELECT peak_online, peak_at")) {
      return cursor([{ peak_online: this.peak.online, peak_at: this.peak.at }]);
    }
    if (normalized.startsWith("INSERT OR IGNORE INTO daily_peaks")) {
      if (this.peak.online > 0 && this.peak.at !== null) {
        const day = new Date(this.peak.at).toISOString().slice(0, 10);
        if (!this.dailyPeaks.has(day)) {
          this.dailyPeaks.set(day, { peak_online: this.peak.online, peak_at: this.peak.at });
        }
      }
      return cursor([]);
    }
    if (normalized.startsWith("INSERT INTO daily_peaks")) {
      const [day, online, at] = values;
      const row = this.dailyPeaks.get(day);
      if (!row || row.peak_online < online) {
        this.dailyPeaks.set(day, { peak_online: online, peak_at: at });
      }
      return cursor([]);
    }
    if (normalized.startsWith("SELECT day, peak_online, peak_at")) {
      const rows = [...this.dailyPeaks.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, row]) => ({ day, peak_online: row.peak_online, peak_at: row.peak_at }));
      return cursor(rows);
    }
    if (normalized.startsWith("DELETE FROM online_clients WHERE last_seen")) {
      const [cutoff] = values;
      for (const [key, client] of this.clients) {
        if (client.lastSeen <= cutoff) this.clients.delete(key);
      }
      return cursor([]);
    }
    if (normalized.startsWith("INSERT INTO online_clients")) {
      const [clientHash, lastSeen] = values;
      this.clients.set(clientHash, { lastSeen });
      return cursor([]);
    }
    if (normalized.startsWith("DELETE FROM online_clients WHERE client_hash")) {
      this.clients.delete(values[0]);
      return cursor([]);
    }
    if (normalized.startsWith("SELECT COUNT(*)")) {
      return cursor([{ count: this.clients.size }]);
    }
    throw new Error("Unexpected SQL statement");
  }
}

function cursor(rows) {
  return {
    one() {
      if (rows.length !== 1) throw new Error("Expected exactly one row");
      return rows[0];
    },
    *[Symbol.iterator]() {
      yield* rows;
    },
  };
}
