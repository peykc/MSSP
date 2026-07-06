import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const PROXY_ORIGIN = "https://nt-audio.pkcollection.net";
const PAGES_ORIGIN = "https://peykc.github.io";
const UPSTREAM_HOST = "traffic.megaphone.fm";

// Emulates the Cloudflare edge cache closely enough for the worker's contract:
// GET-keyed entries, and match() honoring Range headers with 206 responses.
class MockEdgeCache {
  constructor() {
    this.store = new Map();
    this.rejectPuts = false;
  }

  async put(request, response) {
    if (this.rejectPuts) throw new Error("cache put rejected");
    if (response.status !== 200) throw new Error("only 200 responses are cacheable");
    const body = new Uint8Array(await response.arrayBuffer());
    this.store.set(request.url, { headers: new Headers(response.headers), body });
  }

  async match(request) {
    const entry = this.store.get(request.url);
    if (!entry) return undefined;

    const total = entry.body.length;
    const headers = new Headers(entry.headers);
    const range = request.headers.get("Range");
    if (!range) {
      headers.set("Content-Length", String(total));
      return new Response(entry.body.slice(), { status: 200, headers });
    }

    const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!parsed) return new Response(null, { status: 416 });
    const start = Number(parsed[1]);
    const end = parsed[2] === "" ? total - 1 : Math.min(Number(parsed[2]), total - 1);
    const chunk = entry.body.slice(start, end + 1);
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
    headers.set("Content-Length", String(chunk.length));
    return new Response(chunk, { status: 206, headers });
  }
}

function makeAudioBytes(length = 1000) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
  return bytes;
}

// Installs a mock edge cache plus a mock Megaphone upstream, runs the callback,
// and restores globals. The mock records every upstream fetch (URL + init).
async function withProxyMocks(run, { upstream } = {}) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MockEdgeCache();
  const fetchCalls = [];
  const upstreamBytes = makeAudioBytes();

  globalThis.caches = { default: cache };
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (upstream) return upstream();
    return new Response(upstreamBytes.slice(), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  try {
    await run({ cache, fetchCalls, upstreamBytes });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

test("healthz responds 200", async () => {
  const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/healthz`));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("rejects invalid ids and paths with 404", async () => {
  for (const path of [
    "/",
    "/nt/",
    "/nt/../evil",
    "/nt/GLT1;host=x.mp3",
    "/nt/notglt.mp3",
    "/nt/GLT123.wav",
    "/nt/GLT123.mp3/extra",
    "/evil/GLT123.mp3",
    "/nt/GLT12%2F3.mp3",
  ]) {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}${path}`));
    assert.equal(response.status, 404, `expected 404 for ${path}`);
  }
});

test("rejects malformed query params with 404", async () => {
  for (const search of [
    "?updated=abc",
    "?updated=123&updated=456",
    "?updated=123&extra=1",
    "?host=evil.example",
  ]) {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3${search}`));
    assert.equal(response.status, 404, `expected 404 for ${search}`);
  }
});

test("rejects non-GET/HEAD methods with 405", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`, { method }));
    assert.equal(response.status, 405, `expected 405 for ${method}`);
    assert.equal(response.headers.get("Allow"), "GET, HEAD, OPTIONS");
  }
});

test("handles an allowed-origin preflight with 204", async () => {
  const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`, {
    method: "OPTIONS",
    headers: { Origin: PAGES_ORIGIN },
  }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGES_ORIGIN);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Range");
});

test("preflight from a disallowed origin gets no CORS headers", async () => {
  const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("fetches the full file once, caches it, and serves identical bytes", async () => {
  await withProxyMocks(async ({ fetchCalls, upstreamBytes }) => {
    const url = `${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1738626247`;

    const first = await worker.fetch(new Request(url));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Accept-Ranges"), "bytes");
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), upstreamBytes);

    const second = await worker.fetch(new Request(url));
    assert.equal(second.status, 200);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), upstreamBytes);

    assert.equal(fetchCalls.length, 1, "second request must be a cache hit");
    assert.equal(fetchCalls[0].url, "https://traffic.megaphone.fm/GLT123.mp3?updated=1738626247");
  });
});

test("never forwards the client Range header upstream", async () => {
  await withProxyMocks(async ({ fetchCalls }) => {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`, {
      headers: { Range: "bytes=100-200" },
    }));

    assert.equal(fetchCalls.length, 1);
    const forwardedHeaders = new Headers(fetchCalls[0].init?.headers);
    assert.equal(forwardedHeaders.get("Range"), null);
    assert.equal(response.status, 206);
  });
});

test("serves correct 206 ranges from the cached object", async () => {
  await withProxyMocks(async ({ upstreamBytes }) => {
    const url = `${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`;

    const bounded = await worker.fetch(new Request(url, { headers: { Range: "bytes=100-200" } }));
    assert.equal(bounded.status, 206);
    assert.equal(bounded.headers.get("Content-Range"), `bytes 100-200/${upstreamBytes.length}`);
    assert.equal((await bounded.arrayBuffer()).byteLength, 101);

    const openEnded = await worker.fetch(new Request(url, { headers: { Range: "bytes=0-" } }));
    assert.equal(openEnded.status, 206, "Safari's bytes=0- probe must get a 206");
    assert.equal(openEnded.headers.get("Content-Range"), `bytes 0-${upstreamBytes.length - 1}/${upstreamBytes.length}`);
  });
});

test("HEAD returns headers only and populates the cache for the following GET", async () => {
  await withProxyMocks(async ({ fetchCalls, upstreamBytes }) => {
    const url = `${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`;

    const head = await worker.fetch(new Request(url, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Accept-Ranges"), "bytes");
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const get = await worker.fetch(new Request(url));
    assert.equal(get.status, 200);
    assert.deepEqual(new Uint8Array(await get.arrayBuffer()), upstreamBytes);
    assert.equal(fetchCalls.length, 1, "GET after HEAD must be a cache hit");
  });
});

test("rejects non-200 and non-audio upstream responses with 502", async () => {
  const badUpstreams = [
    () => new Response("nope", { status: 404, headers: { "Content-Type": "audio/mpeg" } }),
    () => new Response("partial", { status: 206, headers: { "Content-Type": "audio/mpeg" } }),
    () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  ];

  for (const upstream of badUpstreams) {
    await withProxyMocks(async () => {
      const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`));
      assert.equal(response.status, 502);
    }, { upstream });
  }

  await withProxyMocks(async () => {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`));
    assert.equal(response.status, 502);
  }, { upstream: () => { throw new Error("network down"); } });
});

test("falls back to streaming 200 when cache.put fails", async () => {
  await withProxyMocks(async ({ cache, upstreamBytes }) => {
    cache.rejectPuts = true;
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`));
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), upstreamBytes);
  });
});

test("adds CORS headers for allowed origins only", async () => {
  await withProxyMocks(async () => {
    const url = `${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`;

    const allowed = await worker.fetch(new Request(url, { headers: { Origin: PAGES_ORIGIN } }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), PAGES_ORIGIN);
    assert.equal(
      allowed.headers.get("Access-Control-Expose-Headers"),
      "Content-Length, Content-Range, Accept-Ranges",
    );

    const anonymous = await worker.fetch(new Request(url));
    assert.equal(anonymous.status, 200, "audio elements send no Origin and must still be served");
    assert.equal(anonymous.headers.get("Access-Control-Allow-Origin"), null);

    const disallowed = await worker.fetch(new Request(url, { headers: { Origin: "https://example.com" } }));
    assert.equal(disallowed.status, 200);
    assert.equal(disallowed.headers.get("Access-Control-Allow-Origin"), null);
  });
});

test("only ever fetches the hard-coded Megaphone host", async () => {
  await withProxyMocks(async ({ fetchCalls }) => {
    for (const path of [
      "/nt/GLT123.mp3",
      "/nt/GLT123.mp3?updated=1",
      "/nt/GLTabc987.mp3?updated=42",
    ]) {
      await worker.fetch(new Request(`${PROXY_ORIGIN}${path}`));
    }
    assert.ok(fetchCalls.length > 0);
    for (const call of fetchCalls) {
      assert.equal(new URL(call.url).host, UPSTREAM_HOST);
    }
  });
});

test("strips Megaphone tracking and CORS headers from cached responses", async () => {
  const upstream = () => new Response(makeAudioBytes().slice(), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Access-Control-Allow-Origin": "*",
      "X-Megaphone-Payload": "dai-slot-metadata",
      "X-Megaphone-Payload-2": "dai-slot-metadata",
      Expires: "Mon, 06 Jul 2026 00:00:00 GMT",
      Pragma: "no-cache",
    },
  });

  await withProxyMocks(async () => {
    const response = await worker.fetch(new Request(`${PROXY_ORIGIN}/nt/GLT123.mp3?updated=1`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Megaphone-Payload"), null);
    assert.equal(response.headers.get("X-Megaphone-Payload-2"), null);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(response.headers.get("Expires"), null);
    assert.equal(response.headers.get("Pragma"), null);
  }, { upstream });
});

test("does not fetch upstream at all for invalid requests", async () => {
  await withProxyMocks(async ({ fetchCalls }) => {
    for (const path of [
      "/nt/../GLT123.mp3",
      "/nt/GLT123.mp3?updated=1%26host%3Devil.example",
      "/nt/https%3A%2F%2Fevil.example%2Fx.mp3",
    ]) {
      const response = await worker.fetch(new Request(`${PROXY_ORIGIN}${path}`));
      assert.equal(response.status, 404, `expected 404 for ${path}`);
    }
    assert.equal(fetchCalls.length, 0);
  });
});
