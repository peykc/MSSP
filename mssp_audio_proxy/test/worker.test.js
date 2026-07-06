import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const PROXY_ORIGIN = "https://nt-audio.pkcollection.net";
const PAGES_ORIGIN = "https://peykc.github.io";

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
