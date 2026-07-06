import assert from "node:assert/strict";
import test from "node:test";

import { createCommunityPresence, getListeningEpisodeKey } from "../public/js/community/communityPresence.js";

const EPISODE_A = { episodeKey: "episode-a" };
const EPISODE_B = { episodeKey: "episode-b" };

test("listening eligibility respects playback intent, status, and background playback", () => {
  const base = { selectedEpisode: EPISODE_A, playbackRequested: true };
  assert.equal(getListeningEpisodeKey({ ...base, playbackStatus: "loading_source" }, "visible"), "episode-a");
  assert.equal(getListeningEpisodeKey({ ...base, playbackStatus: "buffering_playback" }, "hidden"), null);
  assert.equal(getListeningEpisodeKey({ ...base, playbackStatus: "playing" }, "hidden"), "episode-a");
  assert.equal(getListeningEpisodeKey({ ...base, playbackStatus: "paused" }, "visible"), null);
  assert.equal(getListeningEpisodeKey({ ...base, playbackStatus: "playing", playbackRequested: false }, "visible"), null);
});

test("presence starts, switches, stops, and reserves keepalive for final cleanup", async () => {
  const documentRef = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const windowRef = new EventTarget();
  windowRef.setInterval = setInterval;
  windowRef.clearInterval = clearInterval;
  const playerState = createPlayerStateHarness();
  const calls = [];
  const communitySignals = {
    async sendPresenceHeartbeat(payload) {
      calls.push(payload);
      return true;
    },
  };
  const presence = createCommunityPresence({
    playerState,
    communitySignals,
    documentRef,
    windowRef,
    heartbeatIntervalMs: 1000,
  });
  presence.start();

  playerState.update({ selectedEpisode: EPISODE_A, playbackRequested: true, playbackStatus: "loading_source" });
  await settle();
  playerState.update({ currentTime: 10 });
  await settle();
  playerState.update({ selectedEpisode: EPISODE_B, playbackRequested: true, playbackStatus: "playing" });
  await settle();
  playerState.update({ playbackRequested: false, playbackStatus: "paused" });
  await settle();

  assert.deepEqual(calls, [
    { episodeKey: "episode-a", playing: true },
    { episodeKey: "episode-a", playing: false },
    { episodeKey: "episode-b", playing: true },
    { episodeKey: "episode-b", playing: false },
  ]);

  playerState.update({ selectedEpisode: EPISODE_A, playbackRequested: true, playbackStatus: "playing" });
  await settle();
  windowRef.dispatchEvent(new Event("beforeunload"));
  await settle();
  assert.deepEqual(calls.at(-1), { episodeKey: "episode-a", playing: false, keepalive: true });
  presence.stop();
});

function createPlayerStateHarness() {
  let state = {
    selectedEpisode: null,
    playbackRequested: false,
    playbackStatus: "idle",
    currentTime: 0,
  };
  const listeners = new Set();
  return {
    getState() { return state; },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    update(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
