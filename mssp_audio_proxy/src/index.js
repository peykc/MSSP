// Proxies New Testament episode audio from Megaphone through the Cloudflare edge
// cache so every listener receives byte-identical, range-capable files instead of
// per-request dynamic-ad-insertion stitches.
const UPSTREAM_BASE = "https://traffic.megaphone.fm/";
const PRODUCTION_ORIGIN = "https://peykc.github.io";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NT_PATH_PATTERN = /^\/nt\/(GLT[A-Za-z0-9]+)\.mp3$/;

// Every edge cache hit is a play Megaphone never sees, so this TTL trades upstream
// play-count credit against byte stability and bandwidth. 24 hours keeps bytes
// identical within any listening session while recent-episode binges still send
// roughly daily fetches per PoP upstream.
const EDGE_TTL_SECONDS = 86400;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, true) });
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(origin);
      }
      return textResponse("ok", 200, origin);
    }

    const target = parseNtTarget(url);
    if (!target) return textResponse("Not found", 404, origin);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(origin);
    }

    return serveAudio(request, target, origin);
  },
};

async function serveAudio(request, target, origin) {
  return textResponse("Not implemented", 501, origin);
}

// Validates /nt/{GLT id}.mp3 with an optional numeric ?updated= param. The upstream
// URL is assembled from these validated parts only, never from raw request input,
// so the worker can never fetch a caller-supplied host.
function parseNtTarget(url) {
  const match = NT_PATH_PATTERN.exec(url.pathname);
  if (!match) return null;

  const id = match[1];
  for (const key of url.searchParams.keys()) {
    if (key !== "updated") return null;
  }
  if (url.searchParams.getAll("updated").length > 1) return null;

  const updated = url.searchParams.get("updated");
  if (updated !== null && !/^\d+$/.test(updated)) return null;

  const suffix = updated !== null ? `?updated=${updated}` : "";
  return {
    id,
    canonicalUrl: `${url.origin}/nt/${id}.mp3${suffix}`,
    upstreamUrl: `${UPSTREAM_BASE}${id}.mp3${suffix}`,
  };
}

function isAllowedOrigin(origin) {
  if (origin === PRODUCTION_ORIGIN) return true;

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.origin === origin
      && !url.username
      && !url.password
      && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

// Audio elements send no Origin header, so requests are never gated on origin;
// allowed origins just get CORS decoration on top.
function corsHeaders(origin, preflight = false) {
  const headers = new Headers({ "X-Content-Type-Options": "nosniff" });
  if (!isAllowedOrigin(origin)) return headers;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function methodNotAllowed(origin) {
  return textResponse("Method not allowed", 405, origin, { Allow: "GET, HEAD, OPTIONS" });
}

function textResponse(body, status, origin, extraHeaders = {}) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(body, { status, headers });
}
