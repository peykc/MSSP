import assert from "node:assert/strict";
import test from "node:test";

import { createCommunitySignals } from "../public/js/community/communitySignals.js";

const API_BASE = "https://msspsignal.pkcollection.net";
const CLIENT_ID = "7f52ca32-8f4c-4f6b-917e-13b9933a61aa";

test("fetchPresencePeaks returns the daily concurrent series", async () => {
  const signals = createCommunitySignals({
    apiBase: API_BASE,
    getClientId: () => CLIENT_ID,
    storage: memoryStorage(),
    windowRef: new EventTarget(),
    documentRef: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    refreshIntervalMs: 60_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/presence/peaks")) {
        return Response.json({
          peak: 84,
          peakAt: "2026-07-22T18:57:00.089Z",
          days: [
            { day: "2026-07-21", peak: 74, peakAt: "2026-07-21T18:48:52.337Z" },
            { day: "2026-07-22", peak: 84, peakAt: "2026-07-22T18:57:00.089Z" },
          ],
        });
      }
      return Response.json({ online: 0 });
    },
  });

  assert.deepEqual(await signals.fetchPresencePeaks(), {
    peak: 84,
    peakAt: "2026-07-22T18:57:00.089Z",
    days: [
      { day: "2026-07-21", peak: 74, peakAt: "2026-07-21T18:48:52.337Z" },
      { day: "2026-07-22", peak: 84, peakAt: "2026-07-22T18:57:00.089Z" },
    ],
  });
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}
