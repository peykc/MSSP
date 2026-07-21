import { EPISODE_KEYS } from "./generated/episodeCatalog.js";
import { GLOBAL_PRESENCE_ROOM, PresenceRoom } from "./presenceRoom.js";

export { PresenceRoom } from "./presenceRoom.js";

const PRODUCTION_ORIGIN = "https://peykc.github.io";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 1024;
const MAX_EPISODE_KEY_LENGTH = 160;
const MAX_BATCH_EPISODES = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROUTES = new Map([
  ["/v1/health", { methods: ["GET"], handler: handleHealth }],
  ["/v1/stars/toggle", { methods: ["POST"], handler: handleStarToggle }],
  ["/v1/stars/counts", { methods: ["GET"], handler: handleStarCounts }],
  ["/v1/views/record", { methods: ["POST"], handler: handleViewRecord }],
  ["/v1/views/counts", { methods: ["GET"], handler: handleViewCounts }],
  ["/v1/visitors/record", { methods: ["POST"], handler: handleVisitorRecord }],
  ["/v1/visitors/total", { methods: ["GET"], handler: handleVisitorTotal }],
  ["/v1/presence/heartbeat", { methods: ["POST"], handler: handlePresenceHeartbeat }],
  ["/v1/presence/online", { methods: ["GET"], handler: handlePresenceOnline }],
  ["/v1/presence/peaks", { methods: ["GET"], handler: handlePresencePeaks }],
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    try {
      return await routeRequest(request, env, origin);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message, origin, error.headers);
      }
      safeDevelopmentLog(env, "REQUEST_FAILED", error);
      return errorResponse(500, "INTERNAL_ERROR", "Internal server error", origin);
    }
  },
};

async function routeRequest(request, env, origin) {
  const url = new URL(request.url);
  const route = ROUTES.get(url.pathname);
  if (!route) throw new HttpError(404, "NOT_FOUND", "Unknown route");
  if (!isAllowedOrigin(origin)) throw new HttpError(403, "ORIGIN_DENIED", "Origin not allowed");

  if (request.method === "OPTIONS") {
    return jsonResponse(null, 204, origin, {
      "Access-Control-Allow-Methods": `${route.methods.join(", ")}, OPTIONS`,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
  }

  if (!route.methods.includes(request.method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
      Allow: `${route.methods.join(", ")}, OPTIONS`,
    });
  }

  return route.handler(request, env, origin, url);
}

function handleHealth(_request, _env, origin, url) {
  rejectAnyQuery(url);
  return jsonResponse({ ok: true, service: "mssp-signals", version: 1 }, 200, origin);
}

async function handleStarToggle(request, env, origin, url) {
  rejectAnyQuery(url);
  const payload = await readJsonBody(request, ["clientId", "episodeKey", "favorite"]);
  validateClientId(payload.clientId);
  validateEpisodeKey(payload.episodeKey);
  if (typeof payload.favorite !== "boolean") {
    throw new HttpError(400, "INVALID_PAYLOAD", "favorite must be a boolean");
  }

  await requireSeededEpisodes(env, [payload.episodeKey]);
  const clientHash = await hashClientId(payload.clientId, env.CLIENT_HASH_SALT);
  await enforceClientRateLimit(env.WRITE_RATE_LIMITER, clientHash);
  const mutation = payload.favorite
    ? env.DB.prepare(
      "INSERT OR IGNORE INTO favorite_edges (episode_key, client_hash, created_at) VALUES (?1, ?2, ?3)",
    ).bind(payload.episodeKey, clientHash, Math.floor(Date.now() / 1000))
    : env.DB.prepare(
      "DELETE FROM favorite_edges WHERE episode_key = ?1 AND client_hash = ?2",
    ).bind(payload.episodeKey, clientHash);
  const countQuery = env.DB.prepare(
    "SELECT COALESCE((SELECT count FROM favorite_counts WHERE episode_key = ?1), 0) AS count",
  ).bind(payload.episodeKey);
  const results = await env.DB.batch([mutation, countQuery]);
  const count = normalizeCount(results.at(-1)?.results?.[0]?.count);

  return jsonResponse({
    episodeKey: payload.episodeKey,
    favorite: payload.favorite,
    count,
  }, 200, origin);
}

async function handleStarCounts(_request, env, origin, url) {
  const episodeKeys = parseEpisodeQuery(url);
  await requireSeededEpisodes(env, episodeKeys);
  const placeholders = episodeKeys.map((_, index) => `?${index + 1}`).join(", ");
  const result = await env.DB.prepare(
    `SELECT episode_key, count FROM favorite_counts WHERE episode_key IN (${placeholders})`,
  ).bind(...episodeKeys).all();
  const counts = new Map((result.results || []).map((row) => [row.episode_key, normalizeCount(row.count)]));
  const episodes = Object.fromEntries(episodeKeys.map((episodeKey) => [
    episodeKey,
    { stars: counts.get(episodeKey) || 0 },
  ]));
  return jsonResponse({ episodes }, 200, origin);
}

async function handleViewRecord(request, env, origin, url) {
  rejectAnyQuery(url);
  const payload = await readJsonBody(request, ["clientId", "episodeKey"]);
  validateClientId(payload.clientId);
  validateEpisodeKey(payload.episodeKey);

  await requireSeededEpisodes(env, [payload.episodeKey]);
  const clientHash = await hashClientId(payload.clientId, env.CLIENT_HASH_SALT);
  await enforceClientRateLimit(env.WRITE_RATE_LIMITER, clientHash);
  const mutation = env.DB.prepare(
    "INSERT OR IGNORE INTO view_edges (episode_key, client_hash, created_at) VALUES (?1, ?2, ?3)",
  ).bind(payload.episodeKey, clientHash, Math.floor(Date.now() / 1000));
  const countQuery = env.DB.prepare(
    "SELECT COALESCE((SELECT count FROM view_counts WHERE episode_key = ?1), 0) AS count",
  ).bind(payload.episodeKey);
  const results = await env.DB.batch([mutation, countQuery]);
  const insertResult = results[0];
  const count = normalizeCount(results.at(-1)?.results?.[0]?.count);
  const counted = Number(insertResult?.meta?.changes) > 0;

  return jsonResponse({
    episodeKey: payload.episodeKey,
    counted,
    views: count,
  }, 200, origin);
}

async function handleViewCounts(_request, env, origin, url) {
  const episodeKeys = parseEpisodeQuery(url);
  await requireSeededEpisodes(env, episodeKeys);
  const placeholders = episodeKeys.map((_, index) => `?${index + 1}`).join(", ");
  const result = await env.DB.prepare(
    `SELECT episode_key, count FROM view_counts WHERE episode_key IN (${placeholders})`,
  ).bind(...episodeKeys).all();
  const counts = new Map((result.results || []).map((row) => [row.episode_key, normalizeCount(row.count)]));
  const episodes = Object.fromEntries(episodeKeys.map((episodeKey) => [
    episodeKey,
    { views: counts.get(episodeKey) || 0 },
  ]));
  return jsonResponse({ episodes }, 200, origin);
}

async function handleVisitorRecord(request, env, origin, url) {
  rejectAnyQuery(url);
  const payload = await readJsonBody(request, ["clientId"]);
  validateClientId(payload.clientId);

  const clientHash = await hashClientId(payload.clientId, env.CLIENT_HASH_SALT);
  await enforceClientRateLimit(env.WRITE_RATE_LIMITER, clientHash);
  const mutation = env.DB.prepare(
    "INSERT OR IGNORE INTO visitor_edges (client_hash, created_at) VALUES (?1, ?2)",
  ).bind(clientHash, Math.floor(Date.now() / 1000));
  const countQuery = env.DB.prepare(
    "SELECT COALESCE((SELECT total FROM visitor_stats WHERE id = 1), 0) AS total",
  );
  const results = await env.DB.batch([mutation, countQuery]);
  const insertResult = results[0];
  const total = normalizeCount(results.at(-1)?.results?.[0]?.total);
  const counted = Number(insertResult?.meta?.changes) > 0;

  return jsonResponse({ counted, total }, 200, origin);
}

async function handleVisitorTotal(_request, env, origin, url) {
  rejectAnyQuery(url);
  const result = await env.DB.prepare(
    "SELECT COALESCE((SELECT total FROM visitor_stats WHERE id = 1), 0) AS total",
  ).all();
  return jsonResponse({
    total: normalizeCount(result.results?.[0]?.total),
  }, 200, origin);
}

async function handlePresenceHeartbeat(request, env, origin, url) {
  rejectAnyQuery(url);
  const payload = await readJsonBody(request, ["clientId", "online"]);
  validateClientId(payload.clientId);
  if (typeof payload.online !== "boolean") {
    throw new HttpError(400, "INVALID_PAYLOAD", "online must be a boolean");
  }

  const clientHash = await hashClientId(payload.clientId, env.CLIENT_HASH_SALT);
  await enforceClientRateLimit(env.HEARTBEAT_RATE_LIMITER, clientHash);
  const response = await globalPresenceStub(env).fetch(
    new Request("https://presence.internal/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientHash, online: payload.online }),
    }),
  );
  const roomResult = await readRoomResponse(response);
  return jsonResponse(publicPresencePayload(roomResult), 200, origin);
}

async function handlePresenceOnline(_request, env, origin, url) {
  rejectAnyQuery(url);
  const response = await globalPresenceStub(env).fetch(
    new Request("https://presence.internal/count"),
  );
  const roomResult = await readRoomResponse(response);
  return jsonResponse(publicPresencePayload(roomResult), 200, origin);
}

async function handlePresencePeaks(_request, env, origin, url) {
  rejectAnyQuery(url);
  const response = await globalPresenceStub(env).fetch(
    new Request("https://presence.internal/peaks"),
  );
  const roomResult = await readPeaksResponse(response);
  return jsonResponse({
    peak: normalizeCount(roomResult.peak),
    peakAt: isoTimestampOrNull(roomResult.peakAt),
    days: roomResult.days.map((entry) => ({
      day: entry.day,
      peak: normalizeCount(entry.peak),
      peakAt: isoTimestampOrNull(entry.peakAt),
    })),
  }, 200, origin);
}

function publicPresencePayload(roomResult) {
  return {
    online: normalizeCount(roomResult.online),
    peak: normalizeCount(roomResult.peak),
    peakAt: isoTimestampOrNull(roomResult.peakAt),
  };
}

function isoTimestampOrNull(epochMs) {
  const ms = Number(epochMs);
  return Number.isSafeInteger(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

async function requireSeededEpisodes(env, episodeKeys) {
  const placeholders = episodeKeys.map((_, index) => `?${index + 1}`).join(", ");
  const result = await env.DB.prepare(
    `SELECT episode_key FROM episode_catalog WHERE episode_key IN (${placeholders})`,
  ).bind(...episodeKeys).all();
  const seeded = new Set((result.results || []).map((row) => row.episode_key));
  if (episodeKeys.some((episodeKey) => !seeded.has(episodeKey))) {
    throw new HttpError(409, "CATALOG_NOT_SEEDED", "Episode catalog is not seeded");
  }
}

function parseEpisodeQuery(url) {
  for (const name of url.searchParams.keys()) {
    if (name !== "episode") {
      throw new HttpError(400, "UNSUPPORTED_QUERY_PARAMETER", "Unsupported query parameter");
    }
  }
  const episodeKeys = [...new Set(url.searchParams.getAll("episode"))];
  if (!episodeKeys.length) {
    throw new HttpError(400, "EPISODES_REQUIRED", "At least one episode parameter is required");
  }
  if (episodeKeys.length > MAX_BATCH_EPISODES) {
    throw new HttpError(400, "BATCH_TOO_LARGE", `At most ${MAX_BATCH_EPISODES} unique episodes are allowed`);
  }
  episodeKeys.forEach(validateEpisodeKey);
  return episodeKeys;
}

function rejectAnyQuery(url) {
  if ([...url.searchParams.keys()].length) {
    throw new HttpError(400, "UNSUPPORTED_QUERY_PARAMETER", "Query parameters are not supported");
  }
}

async function readJsonBody(request, expectedKeys) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
  }

  const bytes = await readBodyBytes(request);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Malformed JSON body");
  }
  if (!isExactObject(payload, expectedKeys)) {
    throw new HttpError(400, "INVALID_PAYLOAD", "Request body has an invalid shape");
  }
  return payload;
}

async function readBodyBytes(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateClientId(clientId) {
  if (typeof clientId !== "string" || !UUID_PATTERN.test(clientId)) {
    throw new HttpError(400, "INVALID_CLIENT_ID", "clientId must be a valid UUID");
  }
}

function validateEpisodeKey(episodeKey) {
  if (typeof episodeKey !== "string" || !episodeKey || episodeKey.length > MAX_EPISODE_KEY_LENGTH) {
    throw new HttpError(400, "INVALID_EPISODE_KEY", "episodeKey is invalid");
  }
  if (!EPISODE_KEYS.has(episodeKey)) {
    throw new HttpError(400, "UNKNOWN_EPISODE", "Unknown episodeKey");
  }
}

export async function hashClientId(clientId, salt) {
  if (typeof salt !== "string" || !salt) {
    throw new HttpError(500, "CONFIGURATION_ERROR", "Server configuration error");
  }
  const input = new TextEncoder().encode(`${salt}:${clientId}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function globalPresenceStub(env) {
  if (!env.PRESENCE?.getByName) {
    throw new HttpError(500, "CONFIGURATION_ERROR", "Server configuration error");
  }
  return env.PRESENCE.getByName(GLOBAL_PRESENCE_ROOM);
}

async function enforceClientRateLimit(limiter, clientHash) {
  if (!limiter?.limit) {
    throw new HttpError(500, "CONFIGURATION_ERROR", "Server configuration error");
  }
  const result = await limiter.limit({ key: clientHash });
  if (!result?.success) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests", {
      "Retry-After": "60",
    });
  }
}

async function readRoomResponse(response) {
  if (!response?.ok) throw new Error("PresenceRoomError");
  const value = await response.json();
  if (!value || typeof value.online !== "number") throw new Error("PresenceRoomPayloadError");
  return value;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function readPeaksResponse(response) {
  if (!response?.ok) throw new Error("PresenceRoomError");
  const value = await response.json();
  if (!value || typeof value.peak !== "number" || !Array.isArray(value.days)) {
    throw new Error("PresenceRoomPayloadError");
  }
  for (const entry of value.days) {
    if (!entry || typeof entry.day !== "string" || !DAY_KEY_PATTERN.test(entry.day)
      || typeof entry.peak !== "number") {
      throw new Error("PresenceRoomPayloadError");
    }
  }
  return value;
}

function isExactObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function isAllowedOrigin(origin) {
  if (origin === PRODUCTION_ORIGIN) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:"
      && url.origin === origin
      && !url.username
      && !url.password
      && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function jsonResponse(value, status, origin, extraHeaders = {}) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  if (isAllowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
}

function errorResponse(status, code, message, origin, extraHeaders = {}) {
  return jsonResponse({ error: { code, message } }, status, origin, extraHeaders);
}

function safeDevelopmentLog(env, routeCode, error) {
  if (env?.ENVIRONMENT !== "development") return;
  const exceptionName = typeof error?.name === "string" ? error.name : "Error";
  console.error("[MSSP Signals]", routeCode, exceptionName);
}

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
