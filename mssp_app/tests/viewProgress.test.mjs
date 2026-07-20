import assert from "node:assert/strict";
import test from "node:test";

import { createViewProgress } from "../public/js/community/viewProgress.js";
import { PLAYBACK_STATUSES } from "../public/js/player/playerState.js";

const EPISODE = { episodeKey: "episode-a" };

test("view progress ignores seek jumps and records after 35 percent played", async () => {
  const storage = memoryStorage();
  const recorded = [];
  const playerState = createPlayerStateHarness();
  const communitySignals = {
    async recordView(episodeKey) {
      recorded.push(episodeKey);
      return true;
    },
  };
  const viewProgress = createViewProgress({
    playerState,
    communitySignals,
    storage,
    threshold: 0.35,
    maxPlayDeltaSeconds: 2.5,
  });
  viewProgress.start();

  playerState.update({
    selectedEpisode: EPISODE,
    playbackStatus: PLAYBACK_STATUSES.PLAYING,
    currentTime: 0,
    duration: 100,
  });
  for (const time of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34]) {
    playerState.update({ currentTime: time });
  }
  await settle();
  assert.equal(recorded.length, 0);

  playerState.update({ currentTime: 36 });
  await settle();
  assert.deepEqual(recorded, ["episode-a"]);
  assert.equal(JSON.parse(storage.getItem("mssp:viewProgress"))["episode-a"].recorded, true);

  playerState.update({ currentTime: 80 });
  assert.equal(recorded.length, 1);
  viewProgress.stop();
});

test("view progress does not accumulate time while paused", async () => {
  const storage = memoryStorage();
  const recorded = [];
  const playerState = createPlayerStateHarness();
  const communitySignals = {
    async recordView(episodeKey) {
      recorded.push(episodeKey);
      return true;
    },
  };
  const viewProgress = createViewProgress({
    playerState,
    communitySignals,
    storage,
    threshold: 0.35,
  });
  viewProgress.start();

  playerState.update({
    selectedEpisode: EPISODE,
    playbackStatus: PLAYBACK_STATUSES.PLAYING,
    currentTime: 0,
    duration: 100,
  });
  playerState.update({ currentTime: 20 });
  playerState.update({ playbackStatus: PLAYBACK_STATUSES.PAUSED, currentTime: 20 });
  playerState.update({ playbackStatus: PLAYBACK_STATUSES.PLAYING, currentTime: 20 });
  playerState.update({ currentTime: 30 });
  assert.equal(recorded.length, 0);
  viewProgress.stop();
});

test("view progress ignores seek jumps without counting skipped time", async () => {
  const storage = memoryStorage();
  const recorded = [];
  const playerState = createPlayerStateHarness();
  const communitySignals = {
    async recordView(episodeKey) {
      recorded.push(episodeKey);
      return true;
    },
  };
  const viewProgress = createViewProgress({
    playerState,
    communitySignals,
    storage,
    threshold: 0.35,
    maxPlayDeltaSeconds: 2.5,
  });
  viewProgress.start();

  playerState.update({
    selectedEpisode: EPISODE,
    playbackStatus: PLAYBACK_STATUSES.PLAYING,
    currentTime: 0,
    duration: 100,
  });
  for (const time of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) {
    playerState.update({ currentTime: time });
  }
  playerState.update({ currentTime: 60 });
  playerState.update({ currentTime: 62 });
  playerState.update({ currentTime: 64 });
  playerState.update({ currentTime: 66 });
  playerState.update({ currentTime: 68 });
  await settle();
  assert.equal(recorded.length, 0);
  viewProgress.stop();
});

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createPlayerStateHarness() {
  let state = {
    selectedEpisode: null,
    playbackStatus: PLAYBACK_STATUSES.IDLE,
    currentTime: 0,
    duration: 0,
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

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}
