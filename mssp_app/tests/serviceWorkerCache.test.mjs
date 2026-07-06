import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
const scope = "https://example.test/app/";

class MemoryCache {
  entries = new Map();

  async match(request) {
    const response = this.entries.get(requestUrl(request));
    return response?.clone();
  }

  async put(request, response) {
    this.entries.set(requestUrl(request), response.clone());
  }

  async delete(request) {
    return this.entries.delete(requestUrl(request));
  }
}

class MemoryCacheStorage {
  stores = new Map();

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    return this.stores.delete(name);
  }
}

function requestUrl(request) {
  return typeof request === "string" ? new URL(request, scope).href : request.url;
}

function createRuntime({ cacheStorage = new MemoryCacheStorage() } = {}) {
  const listeners = new Map();
  let networkVersion = 1;
  let failedPath = null;
  let blockedPath = null;
  let releaseBlockedFetch = null;
  let blockedFetchStarted = null;

  const self = {
    registration: { scope },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    crypto: globalThis.crypto,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };

  const context = vm.createContext({
    self,
    caches: cacheStorage,
    Request,
    Response,
    URL,
    Uint32Array,
    Math,
    Date,
    console,
    fetch: async (request) => {
      const url = new URL(requestUrl(request));
      if (url.pathname === failedPath) return new Response("failed", { status: 503 });
      if (url.pathname === blockedPath) {
        blockedFetchStarted?.();
        await new Promise((resolve) => { releaseBlockedFetch = resolve; });
      }
      return new Response(`network-v${networkVersion}:${url.pathname}${url.search}`);
    },
  });
  vm.runInContext(source, context, { filename: "service-worker.js" });

  return {
    caches: cacheStorage,
    setNetworkVersion(value) { networkVersion = value; },
    fail(path) { failedPath = path; },
    clearFailure() { failedPath = null; },
    block(path) {
      blockedPath = path;
      return new Promise((resolve) => { blockedFetchStarted = resolve; });
    },
    unblock() {
      blockedPath = null;
      releaseBlockedFetch?.();
      releaseBlockedFetch = null;
      blockedFetchStarted = null;
    },
    async lifecycle(type) {
      let task;
      listeners.get(type)({ waitUntil(value) { task = value; } });
      await task;
    },
    async hardRefresh() {
      let task;
      let reply;
      listeners.get("message")({
        data: { type: "HARD_REFRESH" },
        ports: [{ postMessage(value) { reply = value; } }],
        waitUntil(value) { task = value; },
      });
      await task;
      return reply;
    },
    fetch(request) {
      let response;
      listeners.get("fetch")({
        request,
        respondWith(value) { response = value; },
      });
      return response;
    },
  };
}

async function readState(cacheStorage) {
  const meta = await cacheStorage.open("mssp-meta");
  const response = await meta.match(new URL("./__mssp_cache_meta__/state", scope).href);
  return response?.json();
}

test("failed hard refresh preserves the complete active generation", async () => {
  const runtime = createRuntime();
  await runtime.lifecycle("install");
  await runtime.lifecycle("activate");
  const before = await readState(runtime.caches);

  runtime.fail("/app/css/base.css");
  const result = await runtime.hardRefresh();
  const after = await readState(runtime.caches);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CACHE_FETCH_FAILED");
  assert.deepEqual(after.active, before.active);
  assert.deepEqual(after.previous, before.previous);
  assert.deepEqual(
    (await runtime.caches.keys()).filter((name) => name.startsWith("mssp-shell-g")),
    [before.active.shellCache],
  );
});

test("rebuild stays invisible until promotion and retains one rollback generation", async () => {
  const runtime = createRuntime();
  await runtime.lifecycle("install");
  await runtime.lifecycle("activate");
  const before = await readState(runtime.caches);
  const shellRequest = new Request(new URL("./index.html", scope));
  const oldBody = await (await runtime.fetch(shellRequest)).text();

  runtime.setNetworkVersion(2);
  const blocked = runtime.block("/app/css/base.css");
  const refresh = runtime.hardRefresh();
  await blocked;

  assert.equal(await (await runtime.fetch(shellRequest)).text(), oldBody);
  assert.deepEqual((await readState(runtime.caches)).active, before.active);

  runtime.unblock();
  const result = await refresh;
  const after = await readState(runtime.caches);
  assert.equal(result.ok, true);
  assert.equal(after.active.id, result.generation.id);
  assert.equal(after.previous.id, before.active.id);
  assert.notEqual(after.active.id, before.active.id);
  assert.equal((await runtime.caches.keys()).filter((name) => name.startsWith("mssp-shell-g")).length, 2);
  assert.equal((await runtime.caches.keys()).filter((name) => name.startsWith("mssp-data-g")).length, 2);
});

test("missing metadata recovers the newest complete generation", async () => {
  const cacheStorage = new MemoryCacheStorage();
  const firstRuntime = createRuntime({ cacheStorage });
  await firstRuntime.lifecycle("install");
  await firstRuntime.lifecycle("activate");
  firstRuntime.setNetworkVersion(2);
  assert.equal((await firstRuntime.hardRefresh()).ok, true);
  const expected = (await readState(cacheStorage)).active;

  await cacheStorage.delete("mssp-meta");
  const restartedRuntime = createRuntime({ cacheStorage });
  const response = await restartedRuntime.fetch(new Request(new URL("./index.html", scope)));
  assert.equal(response.ok, true);
  assert.equal((await readState(cacheStorage)).active.id, expected.id);
});

test("cross-origin community API requests bypass the service worker", async () => {
  const runtime = createRuntime();
  const response = runtime.fetch(new Request("https://msspsignal.pkcollection.net/v1/stars/counts?episode=test"));
  assert.equal(response, undefined);
});
