import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const ENDPOINT = "https://mssp-rss-proxy.example.workers.dev/feed";
const PAGES_ORIGIN = "https://peykc.github.io";

test("proxies Patreon RSS XML with CORS and no-store headers", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = "";
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  };

  try {
    const response = await worker.fetch(new Request(ENDPOINT, {
      method: "POST",
      headers: {
        Origin: PAGES_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.patreon.com/rss/example?auth=private",
      }),
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGES_ORIGIN);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.match(response.headers.get("Content-Type"), /^application\/rss\+xml/i);
    assert.equal(await response.text(), "<rss><channel></channel></rss>");
    assert.equal(fetchedUrl, "https://www.patreon.com/rss/example?auth=private");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handles an allowed localhost CORS preflight", async () => {
  const origin = "http://localhost:5177";
  const response = await worker.fetch(new Request(ENDPOINT, {
    method: "OPTIONS",
    headers: { Origin: origin },
  }));

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
});

test("rejects disallowed origins", async () => {
  const response = await worker.fetch(new Request(ENDPOINT, {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: "https://www.patreon.com/rss/example" }),
  }));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects non-Patreon and non-RSS URLs", async () => {
  for (const url of [
    "https://example.com/rss/example",
    "https://www.patreon.com/posts/example",
    "http://www.patreon.com/rss/example",
  ]) {
    const response = await worker.fetch(new Request(ENDPOINT, {
      method: "POST",
      headers: {
        Origin: PAGES_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    }));
    assert.equal(response.status, 400);
  }
});
