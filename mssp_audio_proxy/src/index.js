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

// Internal cache-key version. Bump to invalidate every previously cached episode
// (e.g. when the transformation applied to upstream audio changes). v2: promo
// slots are excised before caching.
const CACHE_KEY_VERSION = 2;

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
  const cache = caches.default;
  // The Cache API only stores GET entries, so HEAD requests match (and populate)
  // the GET-keyed object and are stripped to headers at response time. GET
  // requests keep their own headers so cache.match can honor Range with a 206.
  const matchRequest = request.method === "HEAD"
    ? new Request(target.cacheKeyUrl)
    : new Request(target.cacheKeyUrl, { headers: request.headers });

  const hit = await cache.match(matchRequest);
  if (hit) return finalizeAudio(hit, request.method, origin);

  // Always fetch the FULL file: forwarding the client's Range header upstream
  // would re-introduce per-request DAI stitching, the exact bug this proxy kills.
  // redirect:"follow" covers Megaphone's CDN hop (traffic.megaphone.fm 302s to
  // the media host).
  let upstream;
  try {
    upstream = await fetch(target.upstreamUrl, { redirect: "follow" });
  } catch {
    return textResponse("Upstream fetch failed", 502, origin);
  }

  // Require exactly 200 (not just ok): an unprompted upstream 206 would make
  // cache.put reject silently, so fail loud instead.
  const contentType = (upstream.headers.get("Content-Type") || "").toLowerCase();
  if (upstream.status !== 200 || !contentType.includes("audio")) {
    return textResponse("Upstream returned an unexpected response", 502, origin);
  }

  // Megaphone's x-megaphone-payload-2 header is a cut list: it declares the byte
  // range of every ad slot it stitched into this response. Excise the filled
  // slots while streaming so the cached file is the clean, promo-free edition
  // whose timeline matches the canonical episode. Fails open: if the header is
  // missing or unparseable, the audio is cached as received.
  const contentLength = Number(upstream.headers.get("Content-Length"));
  const promoRanges = parsePromoRanges(upstream.headers.get("x-megaphone-payload-2"), contentLength);
  const removedBytes = promoRanges.reduce((sum, [start, end]) => sum + (end - start), 0);
  const body = promoRanges.length
    ? upstream.body.pipeThrough(createPromoStripper(promoRanges))
    : upstream.body;

  const cacheable = new Response(body, upstream);
  // Strip Megaphone's DAI slot metadata (x-megaphone-payload*), its blanket
  // ACAO (*) so this worker's per-origin CORS policy stays authoritative, and
  // legacy caching headers that would fight the Cache-Control set below.
  for (const name of [...cacheable.headers.keys()]) {
    if (name.startsWith("x-megaphone") || name.startsWith("access-control-")) {
      cacheable.headers.delete(name);
    }
  }
  cacheable.headers.delete("Set-Cookie");
  cacheable.headers.delete("Expires");
  cacheable.headers.delete("Pragma");
  cacheable.headers.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}`);
  cacheable.headers.set("Accept-Ranges", "bytes");
  if (removedBytes > 0) {
    cacheable.headers.set("Content-Length", String(contentLength - removedBytes));
    cacheable.headers.set("X-MSSP-Promos-Removed", `${promoRanges.length} slot(s), ${removedBytes} bytes`);
  }

  // Awaited on purpose: iOS Safari opens media with "Range: bytes=0-" and needs a
  // real 206, which cache.match can only produce once the full object is stored.
  // The first listener of an uncached episode waits out the edge->Megaphone
  // transfer; every later request at that PoP is a cache hit.
  try {
    await cache.put(new Request(target.cacheKeyUrl), cacheable.clone());
  } catch {
    // Object rejected by the cache (e.g. too large): degrade to streaming the
    // upstream body as a plain 200.
    return finalizeAudio(cacheable, request.method, origin);
  }

  const served = await cache.match(matchRequest);
  return finalizeAudio(served ?? cacheable, request.method, origin);
}

// Parses Megaphone's x-megaphone-payload-2 header into byte ranges to remove,
// each [start, endExclusive). Header grammar (validated against live responses):
// comma-separated slots before an "@", fields "#"-separated per slot:
//   <adId>#<lastByteInclusive>#<type>#<index>#<firstByte>#<creativeId>#...
// Unfilled slots have empty adId/creativeId and degenerate offsets. Anything
// that fails validation yields [] so the caller falls back to unmodified audio.
export function parsePromoRanges(payloadHeader, contentLength) {
  if (!payloadHeader || !Number.isInteger(contentLength) || contentLength <= 0) return [];

  const ranges = [];
  for (const slot of payloadHeader.split("@")[0].split(",")) {
    const fields = slot.split("#");
    if (fields.length < 6) continue;
    const [adId, lastByteRaw, , , firstByteRaw, creativeId] = fields;
    if (!adId || !creativeId) continue; // unfilled slot

    const firstByte = Number(firstByteRaw);
    const lastByte = Number(lastByteRaw);
    if (!Number.isInteger(firstByte) || !Number.isInteger(lastByte)) return [];
    if (firstByte < 0 || lastByte < firstByte || lastByte + 1 > contentLength) return [];
    ranges.push([firstByte, lastByte + 1]);
  }

  ranges.sort((left, right) => left[0] - right[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i][0] < ranges[i - 1][1]) return []; // overlapping slots: distrust the header
  }
  return ranges;
}

// TransformStream that drops the given absolute byte ranges ([start, endExclusive),
// sorted, non-overlapping) from a stream, emitting everything else untouched.
export function createPromoStripper(ranges) {
  let position = 0;
  let rangeIndex = 0;

  return new TransformStream({
    transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.byteLength && rangeIndex < ranges.length) {
        const absolute = position + offset;
        const [start, end] = ranges[rangeIndex];
        if (absolute < start) {
          const emitEnd = Math.min(chunk.byteLength, offset + (start - absolute));
          controller.enqueue(chunk.subarray(offset, emitEnd));
          offset = emitEnd;
        } else {
          offset += Math.min(chunk.byteLength - offset, end - absolute);
          if (position + offset >= end) rangeIndex += 1;
        }
      }
      if (offset < chunk.byteLength) controller.enqueue(chunk.subarray(offset));
      position += chunk.byteLength;
    },
  });
}

// Copies the (immutable) cached/upstream response so headers can be decorated
// per-request. CORS is intentionally not stored in the cache entry.
function finalizeAudio(response, method, origin) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);
  for (const [name, value] of cors.entries()) headers.set(name, value);
  if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");
  // The edge cache entry keeps its long TTL; browsers should revalidate through
  // the edge instead of long-caching stitched media themselves.
  headers.set("Cache-Control", "no-store");

  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    // Internal cache key only (never routed): carries the transform version so
    // bumping CACHE_KEY_VERSION orphans previously cached entries.
    cacheKeyUrl: `${url.origin}/nt/${id}.mp3?cv=${CACHE_KEY_VERSION}${updated !== null ? `&updated=${updated}` : ""}`,
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
