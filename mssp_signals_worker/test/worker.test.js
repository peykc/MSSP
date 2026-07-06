import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, { hashClientId } from "../src/index.js";
import { EPISODE_KEYS } from "../src/generated/episodeCatalog.js";
import { PresenceRoom, PRESENCE_TTL_MS } from "../src/presenceRoom.js";

const API_ORIGIN = "https://peykc.github.io";
const API_BASE = "https://mssp-signals.example.workers.dev";
const CLIENT_ONE = "7f52ca32-8f4c-4f6b-917e-13b9933a61aa";
const CLIENT_TWO = "bddab51d-b7fa-4bb5-b7df-fc090d38d15f";
const SALT = "test-only-salt";
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
  const counts = await callWorker(env, `/v1/presence/counts?episode=${encodeURIComponent(EPISODE_ONE)}`);
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

test("count queries allow repeated parameters, dedupe values, and reject unsupported input", async () => {
  const env = createEnv();
  const repeated = new URLSearchParams();
  repeated.append("episode", EPISODE_ONE);
  repeated.append("episode", EPISODE_ONE);
  repeated.append("episode", EPISODE_TWO);
  const response = await callWorker(env, `/v1/presence/counts?${repeated}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys((await response.json()).episodes), [EPISODE_ONE, EPISODE_TWO]);
  assert.deepEqual(env.PRESENCE.requestedNames, [EPISODE_ONE, EPISODE_TWO]);

  const unsupported = await callWorker(env, `/v1/presence/counts?episodes=${encodeURIComponent(EPISODE_ONE)}`);
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_QUERY_PARAMETER");

  const tooMany = new URLSearchParams();
  [EPISODE_ONE, EPISODE_TWO, ...OTHER_EPISODES.slice(0, 19)]
    .forEach((episodeKey) => tooMany.append("episode", episodeKey));
  const oversizedBatch = await callWorker(env, `/v1/presence/counts?${tooMany}`);
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
    episodeKey: EPISODE_ONE,
    playing: true,
  });
  assert.equal(JSON.stringify(env.PRESENCE.payloads).includes(CLIENT_ONE), false);
  assert.equal(env.PRESENCE.payloads[0].clientHash, expected);
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

test("presence count fan-out isolates failed rooms and logs no request identifiers", async () => {
  const env = createEnv({ environment: "development" });
  env.PRESENCE.rooms.set(EPISODE_ONE, new Map([["hash", true]]));
  env.PRESENCE.failedNames.add(EPISODE_TWO);
  const query = new URLSearchParams();
  query.append("episode", EPISODE_ONE);
  query.append("episode", EPISODE_TWO);

  const messages = [];
  const originalError = console.error;
  console.error = (...values) => messages.push(values);
  try {
    const response = await callWorker(env, `/v1/presence/counts?${query}`);
    assert.deepEqual(await response.json(), {
      episodes: {
        [EPISODE_ONE]: { listeners: 1 },
        [EPISODE_TWO]: { listeners: 0 },
      },
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(messages, [["[MSSP Signals]", "PRESENCE_ROOM_COUNT_FAILED", "Error"]]);
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes(EPISODE_TWO), false);
  assert.equal(serialized.includes(CLIENT_ONE), false);
});

test("PresenceRoom dedupes clients, clears stops, and expires stale listeners", async () => {
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
    assert.equal(await roomHeartbeat(room, clientHash, true), 1);
    assert.equal(await roomHeartbeat(room, clientHash, true), 1);
    now += PRESENCE_TTL_MS - 1;
    assert.equal(await roomCount(room), 1);
    now += 1;
    assert.equal(await roomCount(room), 0);
    assert.equal(await roomHeartbeat(room, clientHash, true), 1);
    assert.equal(await roomHeartbeat(room, clientHash, false), 0);
  } finally {
    Date.now = originalNow;
  }
});

test("D1 migration contains idempotent trigger-maintained favorite counts", async () => {
  const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  assert.match(migration, /PRIMARY KEY \(episode_key, client_hash\)/);
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS favorite_edges_after_insert/);
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS favorite_edges_after_delete/);
  assert.match(migration, /MAX\(count - 1, 0\)/);
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

async function roomHeartbeat(room, clientHash, playing) {
  const response = await room.fetch(new Request("https://presence.internal/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientHash, playing }),
  }));
  return (await response.json()).listeners;
}

async function roomCount(room) {
  const response = await room.fetch(new Request("https://presence.internal/count"));
  return (await response.json()).listeners;
}

class MockD1 {
  constructor() {
    this.catalog = new Set(EPISODE_KEYS);
    this.edges = new Set();
    this.counts = new Map();
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
      if (statement.sql.startsWith("DELETE FROM favorite_edges")) {
        const edge = `${episodeKey}\u0000${clientHash}`;
        if (this.edges.delete(edge)) {
          this.counts.set(episodeKey, Math.max((this.counts.get(episodeKey) || 0) - 1, 0));
        }
        return { success: true, results: [] };
      }
      if (statement.sql.startsWith("SELECT COALESCE")) {
        return { success: true, results: [{ count: this.counts.get(episodeKey) || 0 }] };
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
    throw new Error("Unexpected D1 query");
  }
}

class MockPresenceNamespace {
  rooms = new Map();
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
          if (payload.playing) room.set(payload.clientHash, true);
          else room.delete(payload.clientHash);
        }
        return Response.json({ listeners: room.size });
      },
    };
  }
}

class MockSqlStorage {
  listeners = new Map();

  exec(sql, ...values) {
    const normalized = sql.trim();
    if (normalized.startsWith("CREATE TABLE")) return cursor([]);
    if (normalized.startsWith("DELETE FROM listeners WHERE last_seen")) {
      const [cutoff] = values;
      for (const [key, listener] of this.listeners) {
        if (listener.lastSeen <= cutoff) this.listeners.delete(key);
      }
      return cursor([]);
    }
    if (normalized.startsWith("INSERT INTO listeners")) {
      const [clientHash, lastSeen] = values;
      this.listeners.set(clientHash, { playing: 1, lastSeen });
      return cursor([]);
    }
    if (normalized.startsWith("DELETE FROM listeners WHERE client_hash")) {
      this.listeners.delete(values[0]);
      return cursor([]);
    }
    if (normalized.startsWith("SELECT COUNT(*)")) {
      const count = [...this.listeners.values()].filter((listener) => listener.playing === 1).length;
      return cursor([{ count }]);
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
