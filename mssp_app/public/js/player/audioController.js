import { PLAYBACK_STATUSES } from "./playerState.js";

const BUFFERING_GRACE_MS = 900;
const SAVE_INTERVAL_MS = 5000;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;
const HANDOFF_ADVANCE_SECONDS = 0.1;
const DIAGNOSTIC_LIMIT = 40;
const RECONCILABLE_STATUSES = new Set([
  PLAYBACK_STATUSES.LOADING_SOURCE,
  PLAYBACK_STATUSES.BUFFERING_PLAYBACK,
  PLAYBACK_STATUSES.PAUSED,
]);

export function createAudioController({
  playerState,
  playbackProgressStore,
  onEnded,
  onContinuationStarted,
  resolveNextCandidate = () => null,
  getContextVersion = () => ({}),
  createAudioElement = defaultCreateAudioElement,
  scheduleTask = defaultScheduleTask,
  shouldUseStandbyDeck = defaultShouldUseStandbyDeck,
} = {}) {
  const standbyEnabled = Boolean(shouldUseStandbyDeck());
  let activeDeck = createDeck("active");
  let standbyDeck = standbyEnabled ? createDeck("standby") : null;
  let audio = activeDeck.audio;

  let loadedEpisodeKey = null;
  let loadedSourceUrl = null;
  let playbackIntent = false;
  let loadToken = 0;
  let loadEvents = null;
  let bufferingTimer = null;
  let playbackCommandToken = 0;
  let pendingPlayToken = null;
  let restoredLoadToken = null;
  let standbyGeneration = 0;
  let playbackSettingsVersion = 0;
  let pendingHandoff = null;
  let destroyed = false;
  let lastContextFingerprint = contextFingerprint();
  const diagnostics = [];
  const debugPlayback = isPlaybackDebugEnabled();
  recordDiagnostic("controller-init", {
    standbyEnabled,
    deckCount: standbyDeck ? 2 : 1,
  });

  function createDeck(role) {
    const element = createAudioElement(role);
    if (!element) throw new Error(`[MSSP] Could not create the ${role} audio deck.`);
    element.preload = "metadata";
    element.controls = false;
    if (element.dataset) element.dataset.msspAudioDeck = role;
    if (standbyEnabled) attachAudioElement(element);
    return {
      audio: element,
      role,
      standbyEvents: null,
      token: null,
      assignedEpisodeKey: null,
      assignedSourceUrl: null,
      readiness: 0,
      failed: false,
    };
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      savePlaybackPositionNow();
      return;
    }
    restorePlaybackContext();
  }

  function onPageHidden() {
    savePlaybackPositionNow();
  }

  function restorePlaybackContext() {
    if (pendingHandoff) {
      observeHandoffAdvance();
    }
    if (pendingHandoff) {
      void retryPendingHandoff("foreground");
      return;
    }
    reconcilePlaybackState();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", restorePlaybackContext);
  window.addEventListener("focus", restorePlaybackContext);
  window.addEventListener("pagehide", onPageHidden);
  window.addEventListener("beforeunload", onPageHidden);

  const saveInterval = window.setInterval(() => {
    if (!audio.paused && !audio.ended) savePlaybackPositionNow();
  }, SAVE_INTERVAL_MS);

  const unsubscribePlayerState = playerState.subscribe(() => {
    if (!standbyEnabled || destroyed) return;
    const nextFingerprint = contextFingerprint();
    if (lastContextFingerprint !== nextFingerprint) {
      lastContextFingerprint = nextFingerprint;
      if (standbyDeck?.token && !tokenMatchesContext(standbyDeck.token)) {
        invalidateStandby("context-version-changed");
      }
    }
    if (playbackIntent && !pendingHandoff && playerState.getState().playbackStatus === PLAYBACK_STATUSES.PLAYING) {
      prepareStandby();
    }
  });

  function loadSelected({ playbackIntent: shouldPlay = false } = {}) {
    const state = playerState.getState();
    const episode = state.selectedEpisode;
    const source = state.source;

    if (!episode || !source?.url) {
      clearAudio();
      return Promise.resolve(false);
    }

    const sourceChanged = loadedEpisodeKey !== episode.episodeKey || loadedSourceUrl !== source.url;
    if (sourceChanged) {
      invalidateStandby("active-source-changed");
      pendingHandoff = null;
      const token = loadSource(episode.episodeKey, source, shouldPlay);
      setPlaybackIntent(shouldPlay);
      return shouldPlay ? beginPlaybackWhenReady(token) : Promise.resolve(true);
    }

    setPlaybackIntent(shouldPlay);
    return playbackIntent ? play() : Promise.resolve(true);
  }

  async function beginPlaybackWhenReady(token) {
    const ready = await waitUntilCanPlay(token);
    if (!ready || token !== loadToken || !playbackIntent || !isCurrentSource()) return false;
    return play();
  }

  function waitUntilCanPlay(token) {
    if (token !== loadToken || !isCurrentSource()) return Promise.resolve(false);
    if (audio.error) return Promise.resolve(false);
    if (audio.readyState >= HAVE_FUTURE_DATA) return Promise.resolve(true);

    return new Promise((resolve) => {
      const targetAudio = audio;
      const finish = (ready) => {
        cleanup();
        resolve(ready);
      };
      const onCanPlay = () => {
        if (targetAudio !== audio || token !== loadToken || !isCurrentSource()) {
          finish(false);
          return;
        }
        finish(!targetAudio.error);
      };
      const onError = () => finish(false);
      const onAbort = () => finish(false);
      const cleanup = () => {
        targetAudio.removeEventListener("canplay", onCanPlay);
        targetAudio.removeEventListener("error", onError);
        loadEvents?.signal.removeEventListener("abort", onAbort);
      };

      targetAudio.addEventListener("canplay", onCanPlay);
      targetAudio.addEventListener("error", onError);
      loadEvents?.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function isStartingPlayback(status = playerState.getState().playbackStatus) {
    return playbackIntent && (
      pendingPlayToken !== null
      || status === PLAYBACK_STATUSES.LOADING_SOURCE
      || status === PLAYBACK_STATUSES.BUFFERING_PLAYBACK
    );
  }

  async function play() {
    if (pendingHandoff?.audio === audio) return retryPendingHandoff("play-command");

    const state = playerState.getState();
    if (!state.source?.url) return false;
    if (loadedEpisodeKey !== state.selectedEpisode?.episodeKey || loadedSourceUrl !== state.source.url) {
      return loadSelected({ playbackIntent: true });
    }

    const commandToken = ++playbackCommandToken;
    pendingPlayToken = commandToken;
    setPlaybackIntent(true);
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(
      Number.isFinite(audio.duration) && audio.duration > 0
        ? PLAYBACK_STATUSES.BUFFERING_PLAYBACK
        : PLAYBACK_STATUSES.LOADING_SOURCE
    );

    if (audio.readyState < HAVE_FUTURE_DATA && !audio.error) {
      const ready = await waitUntilCanPlay(loadToken);
      if (!ready || commandToken !== playbackCommandToken || !playbackIntent || !isCurrentSource()) {
        if (pendingPlayToken === commandToken) pendingPlayToken = null;
        return false;
      }
    }

    try {
      await audio.play();
      if (pendingPlayToken === commandToken) pendingPlayToken = null;
      if (commandToken !== playbackCommandToken) {
        if (!playbackIntent) audio.pause();
        return false;
      }
      if (!playbackIntent) {
        audio.pause();
        return false;
      }
      return true;
    } catch (error) {
      if (commandToken !== playbackCommandToken || !playbackIntent || !isCurrentSource()) return false;
      if (pendingPlayToken === commandToken) pendingPlayToken = null;

      if (!audio.error && audio.readyState < HAVE_ENOUGH_DATA) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
        void waitUntilCanPlay(loadToken).then((ready) => {
          if (ready && playbackIntent && commandToken === playbackCommandToken) void play();
        });
        return false;
      }

      setPlaybackIntent(false);
      clearBufferingTimer();
      if (playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR) {
        playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
        playerState.setPlaybackError("Press Play to start audio.");
      }
      console.warn("[MSSP] Audio playback did not start.", error);
      return false;
    }
  }

  function pause() {
    playbackCommandToken += 1;
    pendingPlayToken = null;
    pendingHandoff = null;
    setPlaybackIntent(false);
    clearBufferingTimer();
    audio.pause();
    if (playerState.getState().source?.url && playerState.getState().playbackStatus !== PLAYBACK_STATUSES.ERROR) {
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }
    savePlaybackPositionNow();
  }

  function toggle() {
    if (pendingHandoff?.audio === audio) return retryPendingHandoff("in-app-toggle");
    if (playerState.getState().playbackRequested) {
      pause();
      return Promise.resolve(true);
    }
    return play();
  }

  function seek(value, { persist = true } = {}) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return null;
    audio.currentTime = Math.max(0, Math.min(Number(value) || 0, audio.duration));
    updateTimeline();
    if (persist) savePlaybackPositionNow();
    return audio.currentTime;
  }

  function seekBy(offset) {
    return seek(audio.currentTime + Number(offset || 0));
  }

  function seekToRestoredPosition(time) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(Number(time) || 0, audio.duration));
    updateTimeline();
  }

  function restoreSavedPosition() {
    if (!playbackProgressStore || !loadedEpisodeKey) return;
    const savedTime = playbackProgressStore.getRestorablePosition(loadedEpisodeKey, audio.duration);
    if (savedTime !== null) seekToRestoredPosition(savedTime);
  }

  function savePlaybackPositionNow({ episodeKey } = {}) {
    if (!playbackProgressStore) return;
    const key = episodeKey || playerState.getState().selectedEpisode?.episodeKey;
    if (!key) return;
    if (!episodeKey && !isCurrentSource()) return;
    if (audio.ended || !Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(audio.currentTime)) return;
    playbackProgressStore.savePosition({ episodeKey: key, currentTime: audio.currentTime, duration: audio.duration });
  }

  function loadSource(episodeKey, source, shouldPlay) {
    if (loadedEpisodeKey) savePlaybackPositionNow({ episodeKey: loadedEpisodeKey });
    invalidateLoad();
    resetAudioElement(audio);
    configureCrossOrigin(source, audio);
    audio.preload = shouldPlay ? "auto" : "metadata";

    loadedEpisodeKey = episodeKey;
    loadedSourceUrl = source.url;
    activeDeck.assignedEpisodeKey = episodeKey;
    activeDeck.assignedSourceUrl = source.url;
    setPlaybackIntent(shouldPlay);
    const token = loadToken;

    audio.src = source.url;
    bindLoadEvents(token, audio.src, audio);
    playerState.setTimeline({ currentTime: 0, duration: 0 });
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.LOADING_SOURCE);
    audio.load();
    return token;
  }

  function bindLoadEvents(token, expectedMediaUrl, targetAudio) {
    loadEvents = new AbortController();
    const options = { signal: loadEvents.signal };
    const current = (callback) => () => {
      if (
        targetAudio === audio
        && token === loadToken
        && targetAudio.currentSrc === expectedMediaUrl
        && isCurrentSource()
      ) callback();
    };

    targetAudio.addEventListener("loadedmetadata", current(() => {
      updateTimeline();
      if (restoredLoadToken !== token) {
        restoredLoadToken = token;
        restoreSavedPosition();
      }
      if (playerState.getState().playbackStatus === PLAYBACK_STATUSES.LOADING_SOURCE) {
        playerState.setPlaybackStatus(playbackIntent ? PLAYBACK_STATUSES.BUFFERING_PLAYBACK : PLAYBACK_STATUSES.READY);
      }
    }), options);
    targetAudio.addEventListener("durationchange", current(updateTimeline), options);
    targetAudio.addEventListener("timeupdate", current(() => {
      clearBufferingTimer();
      updateTimeline();
      observeHandoffAdvance();
      reconcilePlaybackState("timeupdate");
    }), options);
    targetAudio.addEventListener("waiting", current(markBuffering), options);
    targetAudio.addEventListener("stalled", current(markBuffering), options);
    targetAudio.addEventListener("playing", current(() => {
      clearBufferingTimer();
      if (!targetAudio.paused && !targetAudio.ended) {
        if (playbackIntent) {
          if (!pendingHandoff) playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
          if (!pendingHandoff) prepareStandby();
        } else {
          targetAudio.pause();
        }
      }
    }), options);
    targetAudio.addEventListener("pause", current(() => {
      clearBufferingTimer();
      if (!targetAudio.paused || targetAudio.ended) return;
      const status = playerState.getState().playbackStatus;
      if (![PLAYBACK_STATUSES.LOADING_SOURCE, PLAYBACK_STATUSES.BUFFERING_PLAYBACK, PLAYBACK_STATUSES.PLAYING].includes(status)) return;
      if (pendingHandoff?.audio === targetAudio) return;
      if (isStartingPlayback(status) && targetAudio.readyState < HAVE_ENOUGH_DATA) {
        if (status !== PLAYBACK_STATUSES.BUFFERING_PLAYBACK) playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
        return;
      }
      if (playbackIntent && pendingPlayToken === null) setPlaybackIntent(false);
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
    }), options);
    targetAudio.addEventListener("ended", current(handleActiveEnded), options);
    targetAudio.addEventListener("error", current(handleError), options);
  }

  function handleActiveEnded() {
    const previousEpisodeKey = loadedEpisodeKey;
    clearBufferingTimer();

    if (standbyEnabled && canPromoteStandby(previousEpisodeKey)) {
      promoteStandby(previousEpisodeKey);
      return;
    }

    recordDiagnostic("handoff-fallback", {
      previousEpisodeKey,
      standbyReason: describeStandbyInvalidity(previousEpisodeKey),
    });
    const advanced = onEnded?.({ previousEpisodeKey }) === true;
    stageCompletedEpisode(previousEpisodeKey);
    if (!advanced) {
      setPlaybackIntent(false);
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.ENDED);
    }
  }

  function promoteStandby(previousEpisodeKey) {
    const consumedToken = standbyDeck.token;
    const previousDeck = activeDeck;
    const promotedDeck = standbyDeck;
    const previousLoadEvents = loadEvents;

    activeDeck = promotedDeck;
    standbyDeck = previousDeck;
    audio = promotedDeck.audio;
    promotedDeck.role = "active";
    previousDeck.role = "standby";
    if (audio.dataset) audio.dataset.msspAudioDeck = "active";
    if (previousDeck.audio.dataset) previousDeck.audio.dataset.msspAudioDeck = "standby";
    promotedDeck.token = null;
    standbyDeck.token = null;
    copyPlaybackSettings(previousDeck.audio, audio);

    const startedAt = now();
    const startTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    let playPromise;
    try {
      playPromise = Promise.resolve(audio.play());
    } catch (error) {
      playPromise = Promise.reject(error);
    }

    // Nothing above this line may dispatch app state, render, or persist.
    loadedEpisodeKey = consumedToken.episodeKey;
    loadedSourceUrl = consumedToken.sourceUrl;
    promotedDeck.assignedEpisodeKey = consumedToken.episodeKey;
    promotedDeck.assignedSourceUrl = consumedToken.sourceUrl;
    playbackIntent = true;
    pendingPlayToken = null;
    playbackCommandToken += 1;
    loadToken += 1;
    const promotedLoadToken = loadToken;
    restoredLoadToken = null;
    pendingHandoff = {
      audio,
      candidate: consumedToken.candidate,
      previousEpisodeKey,
      startTime,
      startedAt,
      attempt: 1,
      playResult: "pending",
    };

    onContinuationStarted?.(consumedToken.candidate);

    previousLoadEvents?.abort();
    promotedDeck.standbyEvents?.abort();
    promotedDeck.standbyEvents = null;
    loadEvents = null;
    bindLoadEvents(promotedLoadToken, audio.currentSrc || audio.src, audio);
    updateTimeline();
    restoreSavedPosition();
    playbackProgressStore?.markCompletedInMemory(previousEpisodeKey);

    recordDiagnostic("handoff-start", {
      previousEpisodeKey,
      nextEpisodeKey: consumedToken.episodeKey,
      ...mediaSnapshot(audio),
    });
    void observePlayResult(playPromise, pendingHandoff);

    scheduleTask(() => {
      playbackProgressStore?.flushPending();
      playerState.persistCurrentState?.();
      resetDeckForStandby(standbyDeck);
    });
  }

  async function observePlayResult(playPromise, handoff) {
    try {
      await playPromise;
      if (pendingHandoff !== handoff) return;
      handoff.playResult = "resolved";
      recordDiagnostic("handoff-play-resolved", mediaSnapshot(handoff.audio));
    } catch (error) {
      if (pendingHandoff !== handoff) return;
      handoff.playResult = "rejected";
      playbackIntent = false;
      playerState.setPlaybackRequested(false);
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PAUSED);
      playerState.setPlaybackError("Press Play to continue the next episode.");
      recordDiagnostic("handoff-play-rejected", {
        message: error?.message || String(error),
        ...mediaSnapshot(handoff.audio),
      });
    }
  }

  function observeHandoffAdvance() {
    const handoff = pendingHandoff;
    if (!handoff || handoff.audio !== audio) return;
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (currentTime - handoff.startTime < HANDOFF_ADVANCE_SECONDS) return;

    pendingHandoff = null;
    playbackIntent = true;
    playerState.setPlaybackRequested(true);
    playerState.setPlaybackError("");
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
    recordDiagnostic("handoff-advanced", {
      episodeKey: loadedEpisodeKey,
      timeToFirstAdvanceMs: Math.max(0, now() - handoff.startedAt),
      ...mediaSnapshot(audio),
    });
    prepareStandby();
  }

  async function retryPendingHandoff(reason) {
    const handoff = pendingHandoff;
    if (!handoff || handoff.audio !== audio) return play();
    handoff.attempt += 1;
    handoff.startTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    handoff.startedAt = now();
    playbackIntent = true;
    playerState.setPlaybackRequested(true);
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
    playerState.setPlaybackError("");
    try {
      audio.pause();
      const playPromise = Promise.resolve(audio.play());
      handoff.playResult = "pending";
      recordDiagnostic("handoff-retry", { reason, attempt: handoff.attempt, ...mediaSnapshot(audio) });
      void observePlayResult(playPromise, handoff);
      await playPromise;
      return true;
    } catch {
      return false;
    }
  }

  function stageCompletedEpisode(episodeKey) {
    playbackProgressStore?.markCompletedInMemory(episodeKey);
    scheduleTask(() => playbackProgressStore?.flushPending());
  }

  function prepareStandby() {
    if (!standbyEnabled || destroyed || !standbyDeck || !playbackIntent || pendingHandoff || !loadedEpisodeKey) return;
    if (standbyDeck.token && tokenMatchesContext(standbyDeck.token) && standbyDeck.token.fromEpisodeKey === loadedEpisodeKey) return;

    const candidate = resolveNextCandidate(loadedEpisodeKey);
    if (!candidate?.episode?.episodeKey || !candidate.source?.url) {
      invalidateStandby("no-playable-candidate");
      return;
    }

    invalidateStandby("prepare-next", { clearMedia: true });
    const context = normalizedContextVersion();
    const token = Object.freeze({
      candidate,
      episodeKey: candidate.episode.episodeKey,
      fromEpisodeKey: loadedEpisodeKey,
      sourceUrl: candidate.source.url,
      queueVersion: context.queueVersion,
      resolverVersion: context.resolverVersion,
      completionVersion: context.completionVersion,
      playbackSettingsVersion,
      generation: standbyGeneration,
    });

    standbyDeck.token = token;
    standbyDeck.assignedEpisodeKey = token.episodeKey;
    standbyDeck.assignedSourceUrl = token.sourceUrl;
    standbyDeck.readiness = 0;
    standbyDeck.failed = false;
    const standbyAudio = standbyDeck.audio;
    configureCrossOrigin(candidate.source, standbyAudio);
    standbyAudio.preload = "auto";
    standbyDeck.standbyEvents = new AbortController();
    const options = { signal: standbyDeck.standbyEvents.signal };
    const updateReadiness = () => {
      if (standbyDeck?.token !== token) return;
      standbyDeck.readiness = standbyAudio.readyState;
    };
    const failStandby = () => {
      if (standbyDeck?.token !== token) return;
      standbyDeck.failed = true;
      recordDiagnostic("standby-error", { episodeKey: token.episodeKey, ...mediaSnapshot(standbyAudio) });
      invalidateStandby("standby-media-error", { clearMedia: false });
    };
    standbyAudio.addEventListener("loadedmetadata", updateReadiness, options);
    standbyAudio.addEventListener("loadeddata", updateReadiness, options);
    standbyAudio.addEventListener("canplay", updateReadiness, options);
    standbyAudio.addEventListener("error", failStandby, options);
    standbyAudio.src = token.sourceUrl;
    standbyAudio.load();
    recordDiagnostic("standby-prepared", { episodeKey: token.episodeKey, generation: token.generation });
  }

  function canPromoteStandby(previousEpisodeKey) {
    return describeStandbyInvalidity(previousEpisodeKey) === "valid";
  }

  function describeStandbyInvalidity(previousEpisodeKey) {
    const token = standbyDeck?.token;
    if (!standbyDeck || !token) return "missing";
    if (token.fromEpisodeKey !== previousEpisodeKey) return "wrong-origin";
    if (token.generation !== standbyGeneration) return "stale-generation";
    if (!tokenMatchesContext(token)) return "stale-context";
    if (standbyDeck.failed || standbyDeck.audio.error) return "media-error";
    if (standbyDeck.assignedEpisodeKey !== token.episodeKey || standbyDeck.assignedSourceUrl !== token.sourceUrl) return "assignment-mismatch";
    if (standbyDeck.audio.readyState < HAVE_CURRENT_DATA) return "insufficient-data";
    return "valid";
  }

  function tokenMatchesContext(token) {
    const context = normalizedContextVersion();
    return token.queueVersion === context.queueVersion
      && token.resolverVersion === context.resolverVersion
      && token.completionVersion === context.completionVersion
      && token.playbackSettingsVersion === playbackSettingsVersion;
  }

  function normalizedContextVersion() {
    const context = getContextVersion?.() || {};
    return {
      queueVersion: Number(context.queueVersion) || 0,
      resolverVersion: Number(context.resolverVersion) || 0,
      completionVersion: Number(context.completionVersion) || 0,
    };
  }

  function contextFingerprint() {
    const context = normalizedContextVersion();
    return `${context.queueVersion}|${context.resolverVersion}|${context.completionVersion}|${playbackSettingsVersion}`;
  }

  function invalidateStandby(reason, { clearMedia = true } = {}) {
    if (!standbyDeck) return;
    standbyGeneration += 1;
    standbyDeck.standbyEvents?.abort();
    standbyDeck.standbyEvents = null;
    standbyDeck.token = null;
    standbyDeck.assignedEpisodeKey = null;
    standbyDeck.assignedSourceUrl = null;
    standbyDeck.readiness = 0;
    standbyDeck.failed = false;
    if (clearMedia) resetDeckForStandby(standbyDeck);
    if (reason !== "prepare-next" && reason !== "no-playable-candidate") {
      recordDiagnostic("standby-invalidated", { reason, generation: standbyGeneration });
    }
  }

  function notifyContextChanged(reason = "external-context-change") {
    if (!standbyEnabled) return;
    lastContextFingerprint = contextFingerprint();
    invalidateStandby(reason);
    if (playbackIntent && !pendingHandoff) prepareStandby();
  }

  function setPlaybackRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return audio.playbackRate;
    if (audio.playbackRate === rate) return rate;
    audio.playbackRate = rate;
    playbackSettingsVersion += 1;
    invalidateStandby("playback-rate-changed");
    if (playbackIntent && !pendingHandoff) prepareStandby();
    return rate;
  }

  function copyPlaybackSettings(fromAudio, toAudio) {
    toAudio.playbackRate = Number.isFinite(fromAudio.playbackRate) ? fromAudio.playbackRate : 1;
    for (const property of ["preservesPitch", "webkitPreservesPitch"]) {
      if (property in fromAudio && property in toAudio) {
        try {
          toAudio[property] = fromAudio[property];
        } catch {
          // Pitch preservation support varies across media implementations.
        }
      }
    }
  }

  function resetDeckForStandby(deck) {
    if (!deck) return;
    deck.standbyEvents?.abort();
    deck.standbyEvents = null;
    resetAudioElement(deck.audio);
    deck.audio.preload = "metadata";
    deck.assignedEpisodeKey = null;
    deck.assignedSourceUrl = null;
    deck.readiness = 0;
    deck.failed = false;
    deck.token = null;
  }

  function handleError() {
    pendingPlayToken = null;
    playbackIntent = false;
    pendingHandoff = null;
    invalidateStandby("active-media-error");
    clearBufferingTimer();
    playerState.setPlaybackRequested(false);
    playerState.setPlaybackStatus(PLAYBACK_STATUSES.ERROR);
    playerState.setPlaybackError("Unable to play audio. Tap Play to retry.");
  }

  function markBuffering() {
    clearBufferingTimer();
    const stalledAtTime = audio.currentTime;
    bufferingTimer = window.setTimeout(() => {
      bufferingTimer = null;
      const snapshot = getAudioSnapshot();
      if (
        playbackIntent
        && snapshot.isCurrentSource
        && !snapshot.paused
        && !snapshot.ended
        && Number.isFinite(snapshot.currentTime)
        && Math.abs(snapshot.currentTime - stalledAtTime) < 0.01
      ) playerState.setPlaybackStatus(PLAYBACK_STATUSES.BUFFERING_PLAYBACK);
    }, BUFFERING_GRACE_MS);
  }

  function updateTimeline() {
    playerState.setTimeline({
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    });
  }

  function clearAudio() {
    invalidateStandby("clear-audio");
    invalidateLoad();
    resetAudioElement(audio);
    loadedEpisodeKey = null;
    loadedSourceUrl = null;
    activeDeck.assignedEpisodeKey = null;
    activeDeck.assignedSourceUrl = null;
    pendingHandoff = null;
    setPlaybackIntent(false);
    playerState.setTimeline({ currentTime: 0, duration: 0 });
  }

  function invalidateLoad() {
    clearBufferingTimer();
    playbackCommandToken += 1;
    pendingPlayToken = null;
    loadToken += 1;
    loadEvents?.abort();
    loadEvents = null;
  }

  function resetAudioElement(targetAudio) {
    targetAudio.pause();
    targetAudio.removeAttribute("src");
    targetAudio.removeAttribute("crossorigin");
    targetAudio.crossOrigin = null;
    targetAudio.load();
  }

  function configureCrossOrigin(source, targetAudio) {
    if (source?.sourceType === "r2_audio" || source?.sourceType === "patreon_r2_audio") {
      targetAudio.crossOrigin = "anonymous";
      return;
    }
    targetAudio.removeAttribute("crossorigin");
    targetAudio.crossOrigin = null;
  }

  function isCurrentSource() {
    const state = playerState.getState();
    return loadedEpisodeKey === state.selectedEpisode?.episodeKey && loadedSourceUrl === state.source?.url;
  }

  function getAudioSnapshot() {
    return {
      paused: audio.paused,
      ended: audio.ended,
      currentTime: audio.currentTime,
      readyState: audio.readyState,
      isCurrentSource: isCurrentSource(),
      playbackIntent,
      pendingHandoff: Boolean(pendingHandoff),
    };
  }

  function getCurrentTime() {
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  }

  function getPlaybackRate() {
    return Number.isFinite(audio.playbackRate) ? audio.playbackRate : 1;
  }

  function reconcilePlaybackState() {
    if (pendingHandoff) return;
    const snapshot = getAudioSnapshot();
    const status = playerState.getState().playbackStatus;
    if (
      playbackIntent
      && snapshot.isCurrentSource
      && !snapshot.paused
      && !snapshot.ended
      && Number.isFinite(snapshot.currentTime)
      && RECONCILABLE_STATUSES.has(status)
    ) {
      clearBufferingTimer();
      playerState.setPlaybackStatus(PLAYBACK_STATUSES.PLAYING);
    }
  }

  function clearBufferingTimer() {
    window.clearTimeout(bufferingTimer);
    bufferingTimer = null;
  }

  function setPlaybackIntent(requested) {
    playbackIntent = Boolean(requested);
    playerState.setPlaybackRequested(playbackIntent);
  }

  function mediaSnapshot(targetAudio) {
    return {
      readyState: targetAudio.readyState,
      networkState: targetAudio.networkState,
      buffered: readBufferedRanges(targetAudio),
      currentTime: Number.isFinite(targetAudio.currentTime) ? targetAudio.currentTime : null,
      paused: Boolean(targetAudio.paused),
      ended: Boolean(targetAudio.ended),
      visibilityState: document.visibilityState,
      standalone: isStandaloneDisplayMode(),
    };
  }

  function recordDiagnostic(event, detail = {}) {
    const entry = Object.freeze({ event, at: Date.now(), ...detail });
    diagnostics.push(entry);
    if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTIC_LIMIT);
    if (debugPlayback) console.info("[MSSP playback]", entry);
  }

  function getPlaybackDiagnostics() {
    return [...diagnostics];
  }

  function destroy() {
    destroyed = true;
    window.clearInterval(saveInterval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", restorePlaybackContext);
    window.removeEventListener("focus", restorePlaybackContext);
    window.removeEventListener("pagehide", onPageHidden);
    window.removeEventListener("beforeunload", onPageHidden);
    unsubscribePlayerState?.();
    loadEvents?.abort();
    invalidateStandby("destroy");
    resetAudioElement(activeDeck.audio);
    activeDeck.audio.remove?.();
    standbyDeck?.audio.remove?.();
  }

  return {
    destroy,
    getAudioSnapshot,
    getCurrentTime,
    getPlaybackDiagnostics,
    getPlaybackRate,
    loadSelected,
    notifyContextChanged,
    pause,
    play,
    reconcilePlaybackState,
    seek,
    seekBy,
    setPlaybackRate,
    toggle,
  };
}

function defaultCreateAudioElement() {
  return document.createElement("audio");
}

function attachAudioElement(audio) {
  if (audio.isConnected || typeof audio.nodeType !== "number") return;
  (document.body || document.documentElement).appendChild(audio);
}

function defaultScheduleTask(callback) {
  if (typeof queueMicrotask === "function") queueMicrotask(callback);
  else window.setTimeout(callback, 0);
}

function defaultShouldUseStandbyDeck() {
  let override = null;
  try {
    override = new URLSearchParams(window.location.search).get("standbyDeck");
  } catch {
    // Location can be unavailable in isolated tests.
  }
  if (override === "1") return true;
  if (override === "0") return false;
  return isStandaloneDisplayMode() && Number(navigator.maxTouchPoints || 0) > 0;
}

function isStandaloneDisplayMode() {
  return Boolean(
    window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)").matches
    || window.navigator?.standalone === true
  );
}

function isPlaybackDebugEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "playback";
  } catch {
    return false;
  }
}

function readBufferedRanges(audio) {
  const ranges = [];
  try {
    for (let index = 0; index < audio.buffered.length; index += 1) {
      ranges.push([audio.buffered.start(index), audio.buffered.end(index)]);
    }
  } catch {
    // Media ranges can change while they are being inspected.
  }
  return ranges;
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
