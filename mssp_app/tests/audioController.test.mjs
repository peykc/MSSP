import assert from "node:assert/strict";
import test from "node:test";

import { createAudioController } from "../public/js/player/audioController.js";
import { createPlaybackProgressStore } from "../public/js/player/playbackProgressStore.js";
import { PLAYBACK_STATUSES } from "../public/js/player/playerState.js";

class FakeAudio extends EventTarget {
  constructor(role, events) {
    super();
    this.role = role;
    this.events = events;
    this.dataset = {};
    this.preload = "metadata";
    this.controls = false;
    this.currentTime = 0;
    this.duration = 120;
    this.readyState = 0;
    this.networkState = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.webkitPreservesPitch = true;
    this.crossOrigin = null;
    this._src = "";
    this.currentSrc = "";
    this.playCount = 0;
    this.buffered = {
      get length() { return 1; },
      start: () => 0,
      end: () => 12,
    };
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value || "");
    this.currentSrc = this._src;
  }

  load() {
    if (!this._src) {
      this.readyState = 0;
      this.networkState = 0;
      return;
    }
    this.readyState = 3;
    this.networkState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
    this.dispatchEvent(new Event("durationchange"));
    this.dispatchEvent(new Event("loadeddata"));
    this.dispatchEvent(new Event("canplay"));
  }

  play() {
    this.playCount += 1;
    this.events.push(`play:${this.role}`);
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }

  pause() {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name) {
    if (name === "src") {
      this._src = "";
      this.currentSrc = "";
    }
    if (name === "crossorigin") this.crossOrigin = null;
  }

  finish() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("ended"));
  }

  advance(time = 0.25) {
    this.currentTime += time;
    this.dispatchEvent(new Event("timeupdate"));
  }

  remove() {}
}

function installBrowserGlobals() {
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const navigatorValue = { maxTouchPoints: 1, standalone: true };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigatorValue,
  });
  globalThis.document = Object.assign(documentEvents, {
    visibilityState: "visible",
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
  });
  globalThis.window = Object.assign(windowEvents, {
    navigator: navigatorValue,
    location: { search: "" },
    matchMedia: () => ({ matches: true }),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout() {},
  });
}

function createFakePlayerState(episode, source) {
  const listeners = new Set();
  const state = {
    selectedEpisode: episode,
    collectionId: "anthology",
    queueVersion: 1,
    playbackStatus: PLAYBACK_STATUSES.READY,
    playbackRequested: false,
    playbackError: "",
    source,
    currentTime: 0,
    duration: 0,
  };
  const notify = () => listeners.forEach((listener) => listener(state));
  return {
    state,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setPlaybackError(value) { state.playbackError = value; notify(); },
    setPlaybackRequested(value) { state.playbackRequested = Boolean(value); notify(); },
    setPlaybackStatus(value) { state.playbackStatus = value; notify(); },
    setTimeline(value) { Object.assign(state, value); notify(); },
    persistCurrentState() {},
  };
}

function createHarness({ standby = true } = {}) {
  installBrowserGlobals();
  const events = [];
  const tasks = [];
  const audios = [];
  const first = { episodeKey: "ep-1", title: "One" };
  const second = { episodeKey: "ep-2", title: "Two" };
  const firstSource = { url: "https://audio.test/one.mp3", sourceType: "r2_audio" };
  const secondSource = { url: "https://audio.test/two.mp3", sourceType: "r2_audio" };
  const playerState = createFakePlayerState(first, firstSource);
  const context = { queueVersion: 1, resolverVersion: 1, completionVersion: 0 };
  const completed = new Set();
  const progress = {
    getRestorablePosition: () => null,
    savePosition() {},
    markCompletedInMemory(key) {
      completed.add(key);
      context.completionVersion += 1;
    },
    flushPending() {},
  };
  const controller = createAudioController({
    playerState,
    playbackProgressStore: progress,
    createAudioElement(role) {
      events.push(`create:${role}`);
      const audio = new FakeAudio(role, events);
      audios.push(audio);
      return audio;
    },
    shouldUseStandbyDeck: () => standby,
    scheduleTask: (callback) => tasks.push(callback),
    getContextVersion: () => context,
    resolveNextCandidate: () => ({
      episode: second,
      source: secondSource,
      collectionId: "anthology",
    }),
    onContinuationStarted(candidate) {
      events.push("commit:continuation");
      playerState.state.selectedEpisode = candidate.episode;
      playerState.state.source = candidate.source;
      playerState.state.playbackRequested = true;
      playerState.state.playbackStatus = PLAYBACK_STATUSES.BUFFERING_PLAYBACK;
      playerState.setTimeline({ currentTime: 0, duration: 0 });
    },
    onEnded: () => {
      events.push("fallback:ended");
      return false;
    },
  });
  return { audios, completed, context, controller, events, first, playerState, tasks };
}

test("creates both decks before first play and keeps standby events isolated", async () => {
  const harness = createHarness();
  assert.deepEqual(harness.events.slice(0, 2), ["create:active", "create:standby"]);

  await harness.controller.loadSelected({ playbackIntent: true });
  assert.equal(harness.audios[1].src, "https://audio.test/two.mp3");
  assert.equal(harness.playerState.state.selectedEpisode.episodeKey, "ep-1");
  assert.equal(harness.playerState.state.duration, 120);
});

test("invokes promoted play before committing continuation state and copies settings", async () => {
  const harness = createHarness();
  await harness.controller.loadSelected({ playbackIntent: true });
  harness.controller.setPlaybackRate(1.25);

  harness.audios[0].finish();
  const playIndex = harness.events.lastIndexOf("play:standby");
  const commitIndex = harness.events.indexOf("commit:continuation");
  assert.ok(playIndex >= 0);
  assert.ok(commitIndex > playIndex);
  assert.equal(harness.audios[1].playbackRate, 1.25);
  assert.equal(harness.audios[1].preservesPitch, true);
  assert.equal(harness.completed.has("ep-1"), true);

  harness.audios[1].advance();
  assert.equal(harness.playerState.state.playbackStatus, PLAYBACK_STATUSES.PLAYING);
  assert.equal(harness.controller.getAudioSnapshot().pendingHandoff, false);
});

test("invalid context token falls back instead of promoting standby", async () => {
  const harness = createHarness();
  await harness.controller.loadSelected({ playbackIntent: true });
  harness.context.queueVersion += 1;
  harness.audios[0].finish();

  assert.equal(harness.events.includes("fallback:ended"), true);
  assert.equal(harness.audios[1].playCount, 0);
});

test("an unadvanced handoff makes the first play toggle retry", async () => {
  const harness = createHarness();
  await harness.controller.loadSelected({ playbackIntent: true });
  harness.audios[0].finish();
  assert.equal(harness.audios[1].playCount, 1);

  await harness.controller.toggle();
  assert.equal(harness.audios[1].playCount, 2);
});

test("normal browser path creates only the active deck", () => {
  const harness = createHarness({ standby: false });
  assert.deepEqual(harness.events, ["create:active"]);
});

test("completion can update in memory before storage and external notifications", () => {
  const values = new Map();
  let writes = 0;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes += 1;
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  const notifications = [];
  const store = createPlaybackProgressStore({ onChange: (change) => notifications.push(change) });

  store.markCompletedInMemory("ep-1");
  assert.equal(store.getEpisodeProgress("ep-1").status, "completed");
  assert.equal(store.getCompletionVersion(), 1);
  assert.equal(writes, 0);
  assert.deepEqual(notifications, []);

  store.flushPending();
  assert.equal(writes, 1);
  assert.deepEqual(notifications, [{ completionChanged: true }]);
});
