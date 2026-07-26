import { createArchiveStatsView } from "./archiveStats.js";
import { createCollectionsView } from "./collectionsView.js?v=splash-ready-a";
import { getCommunityClientId } from "./community/communityIdentity.js";
import { createCommunityPresence } from "./community/communityPresence.js?v=poll-cut-a";
import { createCommunitySignals, formatCommunityCount } from "./community/communitySignals.js?v=peaks-secret-a";
import { createPitchCounter } from "./community/pitchCounter.js?v=pitch-d";
import {
  createPresencePeaksChart,
  createSecretTapGesture,
} from "./community/presencePeaksChart.js?v=peaks-secret-a";
import { createViewProgress } from "./community/viewProgress.js";
import { dom } from "./dom.js?v=peaks-secret-a";
import { createEpisodeDetails } from "./episodeDetails.js?v=poll-cut-a";
import { createEpisodeList } from "./episodeList.js?v=share-short-a";
import {
  EPISODE_SHARE_PARAM,
  EPISODE_SHARE_SHORT_PARAM,
  EPISODE_SHARE_TIME_PARAM,
  resolveEpisodeByShortCode,
  setEpisodeShareCatalog,
  setEpisodeShareTimeResolver,
} from "./episodeRow.js?v=share-short-a";
import { createCoverFilters } from "./filters.js";
import { createFavoritesStore } from "./favoritesStore.js";
import { createLibraryView } from "./libraryView.js?v=mini-scroll-a";
import { createAudioController } from "./player/audioController.js?v=playback-speed-p";
import { createMediaSessionController } from "./player/mediaSessionController.js?v=lock-play-a";
import { createPatreonRssModal } from "./patreonRssModal.js?v=splash-ready-a";
import { createPlaybackProgressStore } from "./player/playbackProgressStore.js";
import { createPlayerState, PLAYBACK_STATUSES } from "./player/playerState.js";
import { createPlayerView } from "./player/playerView.js?v=share-short-a";
import { getSourceStatus, SOURCE_STATUSES } from "./player/sourceStatus.js";
import { createA2hsModal, initAddToHomeScreen } from "./a2hsModal.js?v=splash-ready-a";
import { registerServiceWorker, initLaunchPullToRefresh, initPwaUpdates } from "./pwa.js?v=splash-failsafe-a";
import { initSearch } from "./search.js";
import { getPublicSourceForEpisode, loadPublicSources } from "./sources/publicSources.js";
import { createPatreonRssSources } from "./sources/patreonRssSources.js?v=dirty-r2-a";
import { createAppState } from "./state.js";
import { initGlobalTooltip } from "./tooltip.js?v=search-no-tip-a";
import { cancelSplashFailsafe, dismissLaunchSplash } from "./launchSplash.js";

function readSharedEpisodeShortCode() {
  return new URLSearchParams(window.location.search).get(EPISODE_SHARE_SHORT_PARAM)?.trim() || "";
}

function readSharedEpisodeKey() {
  return new URLSearchParams(window.location.search).get(EPISODE_SHARE_PARAM)?.trim() || "";
}

function readSharedEpisodeTime() {
  const raw = new URLSearchParams(window.location.search).get(EPISODE_SHARE_TIME_PARAM)?.trim() || "";
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds);
}

function clearSharedEpisodeParams() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of [EPISODE_SHARE_SHORT_PARAM, EPISODE_SHARE_PARAM, EPISODE_SHARE_TIME_PARAM]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", next);
}

function getApiClient() {
  if (!window.MsspApiClient) {
    throw new Error("[MSSP] MsspApiClient is unavailable. Ensure ./js/apiClient.js loads before ./js/main.js.");
  }
  return window.MsspApiClient;
}

function waitFrames(count = 2) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`[MSSP] Timed out waiting for ${label}.`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function yieldToMain() {
  if (typeof globalThis.scheduler?.yield === "function") {
    await globalThis.scheduler.yield();
    return;
  }
  await waitFrames(1);
}

function scheduleIdle(task) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => {
      void task();
    }, { timeout: 2000 });
    return;
  }
  window.setTimeout(() => {
    void task();
  }, 1);
}

function createLazyOpenProxy(loader) {
  let instancePromise = null;
  function ensure() {
    instancePromise ||= Promise.resolve().then(loader);
    return instancePromise;
  }
  return {
    open: async (...args) => {
      const instance = await ensure();
      return instance.open(...args);
    },
    ensure,
  };
}

async function init() {
  const apiClient = getApiClient();
  const state = createAppState();
  const favoritesStore = createFavoritesStore();
  const communitySignals = createCommunitySignals({
    apiBase: "https://msspsignal.pkcollection.net",
    getClientId: getCommunityClientId,
  });
  communitySignals.start();
  const communityPresence = createCommunityPresence({ communitySignals });
  communityPresence.start();

  let showLifetimeVisitors = false;
  let dawgsOnlineCount = null;
  let siteVisitorTotal = null;
  const dawgsPitchCounter = createPitchCounter(
    dom.dawgsOnline.querySelector("[data-dawgs-online-count]"),
  );

  function renderDawgsMetric() {
    const value = showLifetimeVisitors ? siteVisitorTotal : dawgsOnlineCount;
    const show = Number.isFinite(value) && value > 0;
    const label = showLifetimeVisitors
      ? (show ? `${formatCommunityCount(value)} visited` : "Visited")
      : (show ? `${formatCommunityCount(value)} dawgs online` : "Dawgs online");
    dom.dawgsOnline.hidden = !show;
    dom.dawgsOnline.classList.toggle("dawgs-online--visitors", showLifetimeVisitors);
    dom.dawgsOnline.setAttribute("aria-label", label);
    dom.dawgsOnline.setAttribute(
      "title",
      showLifetimeVisitors ? "Show dawgs online" : "Show lifetime visitors",
    );
    if (!show) {
      dawgsPitchCounter.setValue(null, { animate: false });
      return;
    }
    dawgsPitchCounter.setValue(value, { animate: true });
  }

  communitySignals.subscribeOnline((count) => {
    dawgsOnlineCount = count;
    renderDawgsMetric();
  });
  communitySignals.subscribeVisitors((total) => {
    siteVisitorTotal = total;
    renderDawgsMetric();
  });
  dom.dawgsOnline.addEventListener("click", () => {
    if (showLifetimeVisitors) {
      showLifetimeVisitors = false;
      renderDawgsMetric();
      return;
    }
    if (!Number.isFinite(siteVisitorTotal) || siteVisitorTotal <= 0) return;
    showLifetimeVisitors = true;
    renderDawgsMetric();
  });

  const dawgsPeaksChart = createPresencePeaksChart({
    root: dom.dawgsPeaks,
    fetchPeaks: () => communitySignals.fetchPresencePeaks(),
  });
  const registerHeartSecretTap = createSecretTapGesture({ tapsRequired: 5, gapMs: 650 });
  const dawgsPeaksLayoutQuery = window.matchMedia("(max-width: 760px)");
  const isDawgsPeaksLayout = () => dawgsPeaksLayoutQuery.matches;
  dom.launchHeartSecret.addEventListener("click", () => {
    if (!isDawgsPeaksLayout()) return;
    if (!registerHeartSecretTap()) return;
    void dawgsPeaksChart.toggle();
  });
  dawgsPeaksLayoutQuery.addEventListener("change", (event) => {
    if (!event.matches && dawgsPeaksChart.isOpen()) dawgsPeaksChart.close();
  });

  const archiveStatsView = createArchiveStatsView({ dom, state });
  const dismissGlobalTooltip = initGlobalTooltip();
  try {
    await withTimeout(loadPublicSources(), 3500, "public sources");
  } catch (error) {
    console.warn("[MSSP] Public sources load timed out; continuing launch.", error);
  }
  const patreonSources = createPatreonRssSources();
  const getSourceForEpisode = (episode) => patreonSources.getSourceForEpisode(episode) || getPublicSourceForEpisode(episode);
  const getSourceStatusForEpisode = (episode) => getSourceStatus(episode, getSourceForEpisode(episode));
  const playerState = createPlayerState({ getPublicSourceForEpisode: getSourceForEpisode });
  // Hold splash when a restored player sheet would otherwise paint PAYTCH as locked
  // before the private feed map is hydrated from the stored Patreon URL.
  const shouldHoldSplashForPatreonRestore =
    playerState.hasPersistedState() && Boolean(patreonSources.getStoredUrl());
  if (shouldHoldSplashForPatreonRestore) cancelSplashFailsafe();
  playerState.subscribe((snapshot) => {
    const listening = snapshot.playbackStatus === PLAYBACK_STATUSES.PLAYING;
    communitySignals.setListeningActive(listening);
    communityPresence.setListeningActive(listening);
  });
  const viewProgress = createViewProgress({ playerState, communitySignals });
  viewProgress.start();

  let episodeList;
  let patreonRssModal;
  let archiveEpisodes = [];
  let refreshQueueProgress = null;
  let audioController = null;
  let sourceResolverVersion = 0;
  const playbackProgressStore = createPlaybackProgressStore({
    onChange: ({ completionChanged } = {}) => {
      if (!dom.libraryView.classList.contains("is-hidden")) {
        episodeList?.renderVisibleRows();
      }
      refreshQueueProgress?.();
      if (completionChanged) audioController?.notifyContextChanged("completion-status-changed");
    },
  });
  const queueCache = new Map();

  function toggleFavorite(episode) {
    const previousFavorite = favoritesStore.has(episode);
    const favorite = favoritesStore.toggle(episode);
    communitySignals.setFavorite(episode.episodeKey, { previousFavorite, favorite });
    return favorite;
  }

  async function requestSelect(episode, options) {
    await loadEpisodeForPlayer(episode, {
      ...normalizePlayerRequestOptions(options),
      playbackIntent: false,
    });
  }

  async function requestPlay(episode, options) {
    if (getSourceStatusForEpisode(episode).id === SOURCE_STATUSES.RSS_REQUIRED) {
      patreonRssModal?.open(options?.nodeType ? options : document.activeElement);
      return;
    }
    await loadEpisodeForPlayer(episode, {
      ...normalizePlayerRequestOptions(options),
      playbackIntent: Boolean(getSourceForEpisode(episode)),
    });
  }

  async function playEpisodeAtTime(episode, seconds, options = {}) {
    if (options.timeline) {
      playerView.primeTranscript(episode.episodeKey, options.timeline);
    }

    const playbackIntent = options.playbackIntent !== false;
    const openRequest = playbackIntent ? requestPlay : requestSelect;
    const snapshot = playerState.getState();
    const alreadyLoaded = snapshot.selectedEpisode?.episodeKey === episode.episodeKey && snapshot.duration > 0;
    if (alreadyLoaded) {
      audioController.seek(seconds);
      if (playbackIntent) {
        await requestPlay(episode);
      } else {
        audioController.pause();
        await requestSelect(episode);
      }
      if (options.openTranscript) playerView.openTranscript();
      return;
    }

    const duration = Number(episode.durationSeconds);
    const seedable = seconds >= 5 && Number.isFinite(duration) && duration > 0
      && seconds < duration - 30 && seconds / duration < 0.95;
    if (seedable) {
      // Ride the existing loadedmetadata -> restoreSavedPosition path.
      playbackProgressStore.savePosition({ episodeKey: episode.episodeKey, currentTime: seconds, duration });
    } else {
      // Positions the progress store won't restore (t < 5s or near the end):
      // seek once metadata arrives, after restoreSavedPosition has run.
      const unsubscribe = playerState.subscribe((playerSnapshot) => {
        if (playerSnapshot.selectedEpisode?.episodeKey !== episode.episodeKey) {
          unsubscribe();
          return;
        }
        if (playerSnapshot.duration > 0) {
          unsubscribe();
          requestAnimationFrame(() => audioController.seek(seconds));
        }
      });
    }
    await openRequest(episode);
    if (options.openTranscript) playerView.openTranscript();
  }

  async function loadEpisodeForPlayer(episode, { collectionId: requestedCollectionId, preserveExpanded = false, playbackIntent = false } = {}) {
    state.selectedEpisodeId = episode.id;
    if (state.activeCollection) {
      episodeDetails.renderDetails();
      episodeList.renderVisibleRows();
    }

    const collectionId = requestedCollectionId || state.activeCollection?.id || episode.collectionKind || "anthology";
    let queue = queueCache.get(collectionId);
    const currentPlayerQueue = playerState.getState().queue;
    if (!queue && requestedCollectionId && playerState.getState().collectionId === requestedCollectionId && currentPlayerQueue.length) {
      queue = currentPlayerQueue;
      if (queue.length) queueCache.set(collectionId, queue);
    }
    if (!queue && state.activeCollection?.id === collectionId && !state.query) {
      queue = state.episodes;
      queueCache.set(collectionId, queue);
    }

    playerState.loadEpisode({
      episode,
      collectionId,
      queue: queue || [],
      isExpanded: preserveExpanded ? playerState.getState().isExpanded : false,
    });
    void audioController.loadSelected({ playbackIntent });

    if (!queue) {
      const result = await apiClient.getEpisodes({ collection: collectionId, query: "" });
      queue = result.episodes;
      queueCache.set(collectionId, queue);
      if (
        playerState.getState().selectedEpisode?.episodeKey === episode.episodeKey
        && playerState.getState().collectionId === collectionId
      ) {
        playerState.setQueue(queue);
      }
    }
  }

  function normalizePlayerRequestOptions(options) {
    if (!options || typeof options !== "object" || "nodeType" in options) return {};
    return options;
  }

  function getNextPlaybackCandidate(fromEpisodeKey) {
    const snapshot = playerState.getState();
    const episode = playerState.getNextPlayableEpisode(
      fromEpisodeKey,
      (item) => playbackProgressStore.getEpisodeProgress(item.episodeKey).status !== "completed",
    );
    if (!episode) return null;
    return {
      episode,
      source: getSourceForEpisode(episode),
      collectionId: snapshot.collectionId,
    };
  }

  function stepPlayer(offset, { playbackIntent = true } = {}) {
    if (offset <= 0) {
      const episode = playerState.step(offset);
      if (!episode) return false;
      void audioController.loadSelected({ playbackIntent });
      return true;
    }

    const playerSnapshot = playerState.getState();
    const fromEpisode = playerSnapshot.selectedEpisode;
    if (!fromEpisode) return false;

    const candidate = getNextPlaybackCandidate(fromEpisode.episodeKey);
    if (!candidate) return false;

    playerState.loadEpisode({
      episode: candidate.episode,
      collectionId: playerSnapshot.collectionId,
      queue: playerSnapshot.queue,
      isExpanded: playerSnapshot.isExpanded,
    });
    void audioController.loadSelected({ playbackIntent });
    return true;
  }

  function handleEnded() {
    return stepPlayer(1, { playbackIntent: true });
  }

  function handleContinuationStarted(candidate) {
    if (!candidate?.episode) return;
    playerState.beginContinuation({
      episode: candidate.episode,
      collectionId: candidate.collectionId,
    });
  }

  audioController = createAudioController({
    playerState,
    playbackProgressStore,
    onEnded: handleEnded,
    onContinuationStarted: handleContinuationStarted,
    resolveNextCandidate: getNextPlaybackCandidate,
    getContextVersion: () => ({
      queueVersion: playerState.getState().queueVersion,
      resolverVersion: sourceResolverVersion,
      completionVersion: playbackProgressStore.getCompletionVersion(),
    }),
  });
  createMediaSessionController({ playerState, audioController });
  let inboundShareAnchor = null;
  setEpisodeShareTimeResolver((episode) => {
    const snapshot = playerState.getState();
    const selectedKey = snapshot.selectedEpisode?.episodeKey || "";
    if (!episode?.episodeKey || selectedKey !== episode.episodeKey) return null;
    const live = Number(audioController.getCurrentTime?.() ?? snapshot.currentTime) || 0;
    if (live > 0) return live;
    if (inboundShareAnchor?.episodeKey === episode.episodeKey) {
      return inboundShareAnchor.t;
    }
    return null;
  });
  const playerView = createPlayerView({
    dom,
    playerState,
    audioController,
    favoritesStore,
    communitySignals,
    onFavoriteToggle: toggleFavorite,
    playbackProgressStore,
    getSourceStatusForEpisode,
    onSelectRequest: requestSelect,
    onPlayRequest: requestPlay,
    onLockedRequest: (_episode, trigger) => patreonRssModal?.open(trigger),
    onRegisterQueueRefresh: (fn) => {
      refreshQueueProgress = fn;
    },
  });

  const episodeDetails = createEpisodeDetails({
    dom,
    state,
    favoritesStore,
    communitySignals,
    onFavoriteToggle: toggleFavorite,
  });

  let coverFilters;
  episodeList = createEpisodeList({
    dom,
    state,
    getVisibleEpisodes: () => coverFilters.getVisibleEpisodes(),
    renderDetails: episodeDetails.renderDetails,
    dismissGlobalTooltip,
    onPlayRequest: requestPlay,
    getSourceStatusForEpisode,
    playbackProgressStore,
    favoritesStore,
    communitySignals,
    onFavoriteToggle: toggleFavorite,
  });

  coverFilters = createCoverFilters({
    dom,
    state,
    favoritesStore,
    onFiltersChanged: () => {
      episodeList.applyEpisodeFilters({ preserveScroll: true });
      episodeDetails.renderDetails();
      episodeList.renderVisibleRows();
    },
  });

  const libraryView = createLibraryView({
    dom,
    state,
    apiClient,
    renderCoverFilters: coverFilters.renderCoverFilters,
    closeFilterMenu: coverFilters.closeFilterMenu,
    applyEpisodeFilters: episodeList.applyEpisodeFilters,
    clearRows: episodeList.clearRows,
    renderDetails: episodeDetails.renderDetails,
    renderVisibleRows: episodeList.renderVisibleRows,
    getMiniplayerEpisode: () => playerState.getState().selectedEpisode,
  });

  const calendarModal = createLazyOpenProxy(async () => {
    const { createCalendarModal } = await import("./calendarModal.js?v=heatmap-full-labels-a");
    return createCalendarModal({ dom });
  });
  const fullCalendarModal = createLazyOpenProxy(async () => {
    const { createFullCalendarModal } = await import("./fullCalendarModal.js?v=scroll-bottom-b");
    return createFullCalendarModal({
      dom,
      onSelectEpisode: (episode) => {
        void libraryView.openEpisode(episode);
      },
    });
  });

  const collectionsView = createCollectionsView({
    dom,
    state,
    favoritesStore,
    calendarModal,
    fullCalendarModal,
    onOpenCollection: libraryView.openCollection,
    onOpenFavorites: libraryView.openFavorites,
  });

  async function refreshPrivateSources() {
    sourceResolverVersion += 1;
    audioController.notifyContextChanged("private-source-map-changed");
    playerState.refreshSource();
    await audioController.loadSelected({ playbackIntent: false });
    episodeList?.renderVisibleRows();
    refreshQueueProgress?.();
  }

  patreonRssModal = createPatreonRssModal({
    dom,
    patreonSources,
    getEpisodes: () => archiveEpisodes,
    onSourcesChanged: refreshPrivateSources,
  });

  dom.episodeList.addEventListener("scroll", episodeList.renderVisibleRows, { passive: true });
  window.addEventListener("resize", () => {
    episodeList.renderVisibleRows();
    episodeDetails.updateHeroCoverSize();
    episodeDetails.updateHeroTitleMarquee();
  });
  dom.backButton.addEventListener("click", libraryView.closeLibrary);
  dom.launchFavoritesButton.addEventListener("click", () => {
    void libraryView.openFavorites();
  });

  function syncLaunchFavoritesButton() {
    const count = favoritesStore.getCount();
    const hasFavorites = count > 0;
    const badgeCount = Math.min(count, 9999);
    dom.launchFavoritesButton.classList.toggle("is-active", hasFavorites);
    dom.launchFavoritesButton.setAttribute(
      "aria-label",
      hasFavorites ? `Open favorites (${count})` : "Open favorites",
    );
    dom.launchFavoritesCount.hidden = !hasFavorites;
    dom.launchFavoritesCount.textContent = String(badgeCount);
  }

  // Storage gate: favorites + Paytch URL reflected before splash clears.
  syncLaunchFavoritesButton();
  patreonRssModal.syncLaunchButton();

  const a2hsModal = createA2hsModal({ dom });
  initAddToHomeScreen({ dom, a2hsModal });

  initSearch({ dom, state, loadEpisodes: libraryView.loadEpisodes });

  let episodesByKey = null;
  let globalSearchPromise = null;
  function ensureGlobalSearch() {
    globalSearchPromise ||= import("./globalSearch.js?v=share-short-a").then(({ createGlobalSearch }) => {
      createGlobalSearch({
        dom,
        searchEpisodes: (query) => apiClient.getEpisodes({ collection: "anthology", query }),
        getEpisodeByKey: (episodeKey) => {
          if (!episodesByKey || episodesByKey.size !== archiveEpisodes.length) {
            episodesByKey = new Map(archiveEpisodes.map((episode) => [episode.episodeKey, episode]));
          }
          return episodesByKey.get(episodeKey);
        },
        getSourceStatusForEpisode,
        onSelectEpisode: (episode) => {
          void libraryView.openEpisode(episode);
        },
        onPlayEpisode: requestPlay,
        onPlayEpisodeAtTime: playEpisodeAtTime,
      });
    });
    return globalSearchPromise;
  }
  dom.globalSearchInput?.addEventListener("focus", () => {
    void ensureGlobalSearch();
  }, { once: true });
  dom.globalSearchInput?.addEventListener("pointerdown", () => {
    void ensureGlobalSearch();
  }, { once: true });

  let sealedStonePromise = null;
  function ensureSealedStone() {
    sealedStonePromise ||= import("./sealedStoneModal.js").then(({ createSealedStoneModal }) => {
      createSealedStoneModal({ dom });
    });
    return sealedStonePromise;
  }

  let statsPagePromise = null;
  function ensureStatsPageView() {
    statsPagePromise ||= import("./statsPageView.js").then(({ createStatsPageView }) => {
      return createStatsPageView({ dom });
    });
    return statsPagePromise;
  }

  favoritesStore.subscribe(() => {
    syncLaunchFavoritesButton();
    collectionsView.renderHero();
    if (dom.libraryView.classList.contains("is-hidden")) return;
    if (state.favoritesOnly) {
      episodeList.applyEpisodeFilters({ preserveScroll: true });
    }
    episodeDetails.renderDetails();
    episodeList.renderVisibleRows();
  });

  try {
    const data = await withTimeout(apiClient.getCollections(), 4000, "collections");
    console.info("[MSSP] Data mode:", apiClient.getMode());
    state.collections = data.collections;
    collectionsView.renderCollections();
    void logMetadataDiagnostics(apiClient);

    await waitFrames(2);
    await collectionsView.awaitHeroCoverDecode(400);
  } catch (error) {
    console.error("[MSSP] Failed to start frontend.", error);
  } finally {
    if (!shouldHoldSplashForPatreonRestore) dismissLaunchSplash();
  }

  // Let the browser accept the first scroll before deferred heavy work.
  await yieldToMain();

  scheduleIdle(() => {
    initLaunchPullToRefresh({
      scroller: dom.app,
      launchView: dom.launchView,
    });
  });

  scheduleIdle(async () => {
    const registration = await registerServiceWorker();
    if (!registration) return;
    initPwaUpdates(registration, {
      getPlaybackState: () => playerState.getState(),
      subscribePlayback: (listener) => playerState.subscribe(listener),
    });
  });

  scheduleIdle(() => {
    void ensureSealedStone();
    void ensureStatsPageView();
  });

  try {
    const archiveResult = await apiClient.getEpisodes({ collection: "anthology", query: "" })
      .then((value) => ({ value }))
      .catch((error) => ({ error }));

    await yieldToMain();

    if (archiveResult.value) {
      archiveEpisodes = archiveResult.value.episodes || [];
      setEpisodeShareCatalog(archiveEpisodes);
      communitySignals.setKnownEpisodeKeys(archiveEpisodes.map((episode) => episode.episodeKey));
      favoritesStore.retain(new Set(archiveEpisodes.map((episode) => episode.episodeKey)));
      archiveStatsView.setEpisodes(archiveEpisodes);
      collectionsView.renderExplore();
    } else {
      communitySignals.setKnownEpisodeKeys([]);
      console.error("[MSSP] Could not load archive statistics.", archiveResult.error);
      archiveStatsView.renderError();
    }

    await yieldToMain();

    // When a player sheet will restore, hydrate Patreon sources first so a PAYTCH
    // episode does not flash the locked "Connect Patreon RSS" state.
    if (shouldHoldSplashForPatreonRestore) {
      try {
        await withTimeout(patreonSources.reconnect(archiveEpisodes), 8000, "patreon reconnect");
      } catch (error) {
        console.warn("[MSSP] Patreon reconnect during launch failed; player may stay locked.", error);
      } finally {
        patreonRssModal?.syncLaunchButton?.();
      }
      await playerState.restore(apiClient);
    } else {
      await playerState.restore(apiClient);
      if (patreonSources.getStoredUrl()) {
        void patreonSources.reconnect(archiveEpisodes)
          .then(() => refreshPrivateSources())
          .catch(() => {})
          .finally(() => patreonRssModal?.syncLaunchButton?.());
      }
    }
  } catch (error) {
    console.error("[MSSP] Failed to finish deferred launch bootstrap.", error);
  } finally {
    if (shouldHoldSplashForPatreonRestore) dismissLaunchSplash();
  }

  const sharedEpisodeShortCode = readSharedEpisodeShortCode();
  const sharedEpisodeKey = readSharedEpisodeKey();
  const sharedEpisodeTime = readSharedEpisodeTime();
  if (sharedEpisodeShortCode || sharedEpisodeKey) {
    clearSharedEpisodeParams();
    const sharedEpisode = sharedEpisodeShortCode
      ? resolveEpisodeByShortCode(sharedEpisodeShortCode, archiveEpisodes)
      : archiveEpisodes.find((episode) => episode.episodeKey === sharedEpisodeKey);
    if (sharedEpisode) {
      try {
        if (sharedEpisodeTime != null) {
          inboundShareAnchor = { episodeKey: sharedEpisode.episodeKey, t: sharedEpisodeTime };
          await playEpisodeAtTime(sharedEpisode, sharedEpisodeTime, {
            openTranscript: true,
            playbackIntent: false,
          });
        } else {
          inboundShareAnchor = null;
          await libraryView.openEpisode(sharedEpisode);
        }
      } catch (error) {
        console.warn("[MSSP] Could not open shared episode.", error);
      }
    } else {
      console.warn(
        "[MSSP] Shared episode not found.",
        sharedEpisodeShortCode || sharedEpisodeKey,
      );
    }
  }
}

async function logMetadataDiagnostics(apiClient) {
  // TODO: Remove the metadata debug surface after archive metadata is complete.
  const isDevelopment = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const isDebugRequested = new URLSearchParams(window.location.search).get("debug") === "metadata";
  if (!isDevelopment && !isDebugRequested) return;

  try {
    const health = await apiClient.getHealth();
    if (health.metadataDiagnostics) {
      console.info("[MSSP] Metadata diagnostics", health.metadataDiagnostics);
    }
  } catch (error) {
    console.warn("[MSSP] Metadata diagnostics unavailable.", error);
  }
}

init().catch((error) => {
  console.error("[MSSP] Fatal startup error.", error);
  dismissLaunchSplash();
});
