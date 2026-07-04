import assert from "node:assert/strict";
import test from "node:test";

import {
  getPlaybackSafetyDelay,
  getCacheBustedUrl,
  isPlaybackProtected,
  isPreferredUpdateLease,
  qualifiesPullGesture,
} from "../public/js/pwa.js";

test("protects requested, loading, buffering, and playing audio", () => {
  for (const playbackStatus of ["loading_source", "buffering_playback", "playing"]) {
    assert.equal(isPlaybackProtected({ playbackStatus, playbackRequested: false }), true);
    assert.equal(getPlaybackSafetyDelay({ playbackStatus, playbackRequested: false }), Infinity);
  }
  assert.equal(isPlaybackProtected({ playbackStatus: "ready", playbackRequested: true }), true);
  assert.equal(isPlaybackProtected({ playbackStatus: "ready", playbackRequested: false }), false);
});

test("debounces pause but treats terminal and idle states as immediately safe", () => {
  assert.equal(getPlaybackSafetyDelay({ playbackStatus: "paused", playbackRequested: false }), 3000);
  for (const playbackStatus of ["idle", "ready", "ended", "unavailable", "error"]) {
    assert.equal(getPlaybackSafetyDelay({ playbackStatus, playbackRequested: false }), 0);
  }
});

test("claims only an intentional predominantly vertical pull", () => {
  assert.equal(qualifiesPullGesture(0, 8), false);
  assert.equal(qualifiesPullGesture(2, 9), true);
  assert.equal(qualifiesPullGesture(10, 12), false);
  assert.equal(qualifiesPullGesture(0, -20), false);
});

test("update leases prefer focus priority, then stable election ordering", () => {
  const base = { ownerId: "b", priority: 1, startedAt: 100, expiresAt: 10_100 };
  assert.equal(isPreferredUpdateLease({ ...base, ownerId: "z", priority: 2 }, base), true);
  assert.equal(isPreferredUpdateLease({ ...base, ownerId: "a", startedAt: 99 }, base), true);
  assert.equal(isPreferredUpdateLease({ ...base, ownerId: "a" }, base), true);
  assert.equal(isPreferredUpdateLease({ ...base, ownerId: "z", startedAt: 101 }, base), false);
});

test("LAN fallback navigation changes the document URL without losing existing parameters", () => {
  assert.equal(
    getCacheBustedUrl("http://192.168.1.20:5177/?debug=metadata", 123),
    "http://192.168.1.20:5177/?debug=metadata&mssp-refresh=123",
  );
});
