import assert from "node:assert/strict";
import test from "node:test";

import { createCommunityPresence } from "../public/js/community/communityPresence.js";

test("presence heartbeats while the tab is visible and clears on hide", async () => {
  const documentRef = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const windowRef = new EventTarget();
  windowRef.setInterval = setInterval;
  windowRef.clearInterval = clearInterval;
  const calls = [];
  const communitySignals = {
    async sendOnlineHeartbeat(payload) {
      calls.push(payload);
      return true;
    },
  };
  const presence = createCommunityPresence({
    communitySignals,
    documentRef,
    windowRef,
    heartbeatIntervalMs: 1000,
  });
  presence.start();
  await settle();
  assert.deepEqual(calls, [{ online: true }]);

  documentRef.visibilityState = "hidden";
  documentRef.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.deepEqual(calls, [{ online: true }, { online: false }]);

  documentRef.visibilityState = "visible";
  documentRef.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.deepEqual(calls, [{ online: true }, { online: false }, { online: true }]);

  windowRef.dispatchEvent(new Event("beforeunload"));
  await settle();
  assert.deepEqual(calls.at(-1), { online: false, keepalive: true });
  presence.stop();
});

test("presence stays online while hidden if audio is playing", async () => {
  const documentRef = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const windowRef = new EventTarget();
  windowRef.setInterval = setInterval;
  windowRef.clearInterval = clearInterval;
  const calls = [];
  const communitySignals = {
    async sendOnlineHeartbeat(payload) {
      calls.push(payload);
      return true;
    },
  };
  const presence = createCommunityPresence({
    communitySignals,
    documentRef,
    windowRef,
    heartbeatIntervalMs: 1000,
  });
  presence.start();
  await settle();
  presence.setListeningActive(true);
  documentRef.visibilityState = "hidden";
  documentRef.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.deepEqual(calls, [{ online: true }]);

  presence.setListeningActive(false);
  await settle();
  assert.deepEqual(calls, [{ online: true }, { online: false }]);
  presence.stop();
});

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
