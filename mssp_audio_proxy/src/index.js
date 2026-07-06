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
// (e.g. when the transformation applied to upstream audio changes). v3: promo
// slots are excised before caching, with FixedLengthStream so the cached object
// keeps a Content-Length (required for 206 range serving).
const CACHE_KEY_VERSION = 3;

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
  // slots so the cached file is the clean, promo-free edition whose timeline
  // matches the canonical episode. Fails open: if the header is missing or
  // unparseable, the audio is cached as received.
  const contentLength = Number(upstream.headers.get("Content-Length"));
  const promoRanges = parsePromoRanges(upstream.headers.get("x-megaphone-payload-2"), contentLength);

  if (promoRanges.length) {
    return excisePromosAndServe({
      cache, request, matchRequest, target, origin, upstream, contentLength, promoRanges,
    });
  }

  const cacheable = new Response(upstream.body, {
    status: 200,
    headers: sanitizeUpstreamHeaders(upstream.headers),
  });
  cacheable.headers.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}`);

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

// Removes the promo byte ranges WITHOUT the bytes ever entering JavaScript —
// mandatory on the Workers free plan, whose 10 ms CPU budget a JS TransformStream
// over a ~100 MB file blows through. The raw stitched file is cached under a
// throwaway key (a native copy), then the clean file is assembled from native
// cache range reads pumped through FixedLengthStream, which also gives the final
// object the exact Content-Length that 206 range serving requires.
async function excisePromosAndServe({
  cache, request, matchRequest, target, origin, upstream, contentLength, promoRanges,
}) {
  const removedBytes = promoRanges.reduce((sum, [start, end]) => sum + (end - start), 0);
  const rawKeyUrl = `${new URL(target.cacheKeyUrl).origin}/__raw/${crypto.randomUUID()}`;

  const rawResponse = new Response(upstream.body, {
    status: 200,
    headers: sanitizeUpstreamHeaders(upstream.headers),
  });
  // Short TTL: this entry only needs to survive the assembly below; a random
  // orphan (crashed request) ages out on its own.
  rawResponse.headers.set("Cache-Control", "public, max-age=300");
  try {
    await cache.put(new Request(rawKeyUrl), rawResponse);
  } catch {
    return refetchUnstripped(target, request, origin);
  }

  const cleanedHeaders = sanitizeUpstreamHeaders(upstream.headers);
  cleanedHeaders.delete("Content-Length"); // FixedLengthStream declares the real one
  cleanedHeaders.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}`);
  cleanedHeaders.set("X-MSSP-Promos-Removed", `${promoRanges.length} slot(s), ${removedBytes} bytes`);

  const keepRanges = invertRanges(promoRanges, contentLength);
  const fixed = new FixedLengthStream(contentLength - removedBytes);
  const putPromise = cache.put(
    new Request(target.cacheKeyUrl),
    new Response(fixed.readable, { status: 200, headers: cleanedHeaders }),
  );
  putPromise.catch(() => {}); // outcome handled below; avoid an unhandled rejection

  let assembled = true;
  try {
    if (!keepRanges.length) {
      await fixed.writable.close();
    }
    for (let i = 0; i < keepRanges.length; i += 1) {
      const [start, endInclusive] = keepRanges[i];
      const part = await cache.match(new Request(rawKeyUrl, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
      }));
      if (!part || part.status !== 206 || !part.body) throw new Error("cache range read failed");
      await part.body.pipeTo(fixed.writable, { preventClose: i < keepRanges.length - 1 });
    }
  } catch (error) {
    assembled = false;
    try {
      await fixed.writable.abort(error);
    } catch {}
  }

  if (assembled) {
    try {
      await putPromise;
      await cache.delete(new Request(rawKeyUrl));
      const served = await cache.match(matchRequest);
      if (served) return finalizeAudio(served, request.method, origin);
    } catch {}
  }

  // Fail open: the stitched-but-playable raw copy beats dead air.
  const rawMatchRequest = request.method === "HEAD"
    ? new Request(rawKeyUrl)
    : new Request(rawKeyUrl, { headers: request.headers });
  const raw = await cache.match(rawMatchRequest);
  if (raw) return finalizeAudio(raw, request.method, origin);
  return refetchUnstripped(target, request, origin);
}

// Last-resort degradation: the upstream body was consumed by a failed cache
// write, so fetch the episode again and stream it through unmodified.
async function refetchUnstripped(target, request, origin) {
  let retry;
  try {
    retry = await fetch(target.upstreamUrl, { redirect: "follow" });
  } catch {
    return textResponse("Upstream fetch failed", 502, origin);
  }
  const contentType = (retry.headers.get("Content-Type") || "").toLowerCase();
  if (retry.status !== 200 || !contentType.includes("audio")) {
    return textResponse("Upstream returned an unexpected response", 502, origin);
  }
  return finalizeAudio(new Response(retry.body, {
    status: 200,
    headers: sanitizeUpstreamHeaders(retry.headers),
  }), request.method, origin);
}

// Strips Megaphone's DAI slot metadata (x-megaphone-payload*), its blanket
// ACAO (*) so this worker's per-origin CORS policy stays authoritative, and
// legacy caching headers that would fight the worker's own Cache-Control.
function sanitizeUpstreamHeaders(upstreamHeaders) {
  const headers = new Headers(upstreamHeaders);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-megaphone") || name.startsWith("access-control-")) {
      headers.delete(name);
    }
  }
  headers.delete("Set-Cookie");
  headers.delete("Expires");
  headers.delete("Pragma");
  headers.set("Accept-Ranges", "bytes");
  return headers;
}

// Complements sorted, non-overlapping remove-ranges ([start, endExclusive)) into
// the inclusive keep-ranges used for cache Range reads.
export function invertRanges(removeRanges, contentLength) {
  const keep = [];
  let cursor = 0;
  for (const [start, end] of removeRanges) {
    if (start > cursor) keep.push([cursor, start - 1]);
    cursor = end;
  }
  if (cursor < contentLength) keep.push([cursor, contentLength - 1]);
  return keep;
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
