import { createArchiveStatsView } from "./archiveStats.js";
import { createCalendarModal } from "./calendarModal.js";
import { createFullCalendarModal } from "./fullCalendarModal.js?v=scroll-bottom-b";
import { createGlobalSearch } from "./globalSearch.js?v=sort-reveal-a";
import { createSealedStoneModal } from "./sealedStoneModal.js";
import { createCollectionsView } from "./collectionsView.js?v=cal-preview-b";
import { getCommunityClientId } from "./community/communityIdentity.js";
import { createCommunityPresence } from "./community/communityPresence.js?v=poll-cut-a";
import { createCommunitySignals, formatCommunityCount } from "./community/communitySignals.js?v=poll-cut-a";
import { createPitchCounter } from "./community/pitchCounter.js?v=pitch-d";
import { createViewProgress } from "./community/viewProgress.js";
import { dom } from "./dom.js?v=playback-speed-l";
import { createEpisodeDetails } from "./episodeDetails.js?v=poll-cut-a";
import { createEpisodeList } from "./episodeList.js?v=poll-cut-a";
import { EPISODE_SHARE_PARAM } from "./episodeRow.js?v=poll-cut-a";
import { createCoverFilters } from "./filters.js";
import { createFavoritesStore } from "./favoritesStore.js";
import { createLibraryView } from "./libraryView.js?v=mini-scroll-a";
import { createStatsPageView } from "./statsPageView.js";
import { createAudioController } from "./player/audioController.js?v=playback-speed-p";
import { createMediaSessionController } from "./player/mediaSessionController.js";
import { createPatreonRssModal } from "./patreonRssModal.js";
import { createPlaybackProgressStore } from "./player/playbackProgressStore.js";
import { createPlayerState, PLAYBACK_STATUSES } from "./player/playerState.js";
import { createPlayerView } from "./player/playerView.js?v=ambient-stamp-b";
import { getSourceStatus, SOURCE_STATUSES } from "./player/sourceStatus.js";
import { createA2hsModal, initAddToHomeScreen } from "./a2hsModal.js?v=a2hs-e";
import { registerServiceWorker, initLaunchPullToRefresh, initPwaUpdates } from "./pwa.js?v=pull-overscroll-a";
import { initSearch } from "./search.js";
import { getPublicSourceForEpisode, loadPublicSources } from "./sources/publicSources.js";
import { createPatreonRssSources } from "./sources/patreonRssSources.js";
import { createAppState } from "./state.js";
import { initGlobalTooltip } from "./tooltip.js?v=search-no-tip-a";
import { dismissLaunchSplash } from "./launchSplash.js";

function readSharedEpisodeKey() {
  return new URLSearchParams(window.location.search).get(EPISODE_SHARE_PARAM)?.trim() || "";
}

function clearSharedEpisodeParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(EPISODE_SHARE_PARAM)) return;
  url.searchParams.delete(EPISODE_SHARE_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", next);
}

function getApiClient() {
  if (!window.MsspApiClient) {
    throw new Error("[MSSP] MsspApiClient is unavailable. Ensure ./js/apiClient.js loads before ./js/main.js.");
  }
  return window.MsspApiClient;
}

async function init() {
  const serviceWorkerRegistration = registerServiceWorker();
  initLaunchPullToRefresh({
    scroller: dom.app,
    launchView: dom.launchView,
  });
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
  const calendarModal = createCalendarModal({ dom });
  const statsPageView = createStatsPageView({ dom });
  createSealedStoneModal({ dom });
  const archiveStatsView = createArchiveStatsView({ dom, state });
  const dismissGlobalTooltip = initGlobalTooltip();
  await loadPublicSources();
  const patreonSources = createPatreonRssSources();
  const getSourceForEpisode = (episode) => patreonSources.getSourceForEpisode(episode) || getPublicSourceForEpisode(episode);
  const getSourceStatusForEpisode = (episode) => getSourceStatus(episode, getSourceForEpisode(episode));
  const playerState = createPlayerState({ getPublicSourceForEpisode: getSourceForEpisode });
  playerState.subscribe((snapshot) => {
    const listening = snapshot.playbackStatus === PLAYBACK_STATUSES.PLAYING;
    communitySignals.setListeningActive(listening);
    communityPresence.setListeningActive(listening);
  });
  const viewProgress = createViewProgress({ playerState, communitySignals });
  viewProgress.start();
  void serviceWorkerRegistration.then((registration) => {
    if (!registration) return;
    initPwaUpdates(registration, {
      getPlaybackState: () => playerState.getState(),
      subscribePlayback: (listener) => playerState.subscribe(listener),
    });
  });
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

    const snapshot = playerState.getState();
    const alreadyLoaded = snapshot.selectedEpisode?.episodeKey === episode.episodeKey && snapshot.duration > 0;
    if (alreadyLoaded) {
      audioController.seek(seconds);
      await requestPlay(episode);
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
    await requestPlay(episode);
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

  const fullCalendarModal = createFullCalendarModal({
    dom,
    onSelectEpisode: (episode) => {
      void libraryView.openEpisode(episode);
    },
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

  syncLaunchFavoritesButton();

  const a2hsModal = createA2hsModal({ dom });
  initAddToHomeScreen({ dom, a2hsModal });

  initSearch({ dom, state, loadEpisodes: libraryView.loadEpisodes });

  let episodesByKey = null;
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

  try {
    const [data, archiveResult] = await Promise.all([
      apiClient.getCollections(),
      apiClient.getEpisodes({ collection: "anthology", query: "" })
        .then((value) => ({ value }))
        .catch((error) => ({ error })),
    ]);
    console.info("[MSSP] Data mode:", apiClient.getMode());
    state.collections = data.collections;
    if (archiveResult.value) {
      archiveEpisodes = archiveResult.value.episodes || [];
      communitySignals.setKnownEpisodeKeys(archiveEpisodes.map((episode) => episode.episodeKey));
      favoritesStore.retain(new Set(archiveEpisodes.map((episode) => episode.episodeKey)));
      archiveStatsView.setEpisodes(archiveEpisodes);
    } else {
      communitySignals.setKnownEpisodeKeys([]);
      console.error("[MSSP] Could not load archive statistics.", archiveResult.error);
      archiveStatsView.renderError();
    }
    collectionsView.renderCollections();
    void logMetadataDiagnostics(apiClient);

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
    await playerState.restore(apiClient);

    if (patreonSources.getStoredUrl()) {
      void patreonSources.reconnect(archiveEpisodes)
        .then(() => refreshPrivateSources())
        .catch(() => {})
        .finally(() => patreonRssModal?.syncLaunchButton?.());
    } else {
      patreonRssModal?.syncLaunchButton?.();
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  } catch (error) {
    console.error("[MSSP] Failed to start frontend.", error);
  } finally {
    dismissLaunchSplash();
  }

  const sharedEpisodeKey = readSharedEpisodeKey();
  if (sharedEpisodeKey) {
    clearSharedEpisodeParam();
    const sharedEpisode = archiveEpisodes.find((episode) => episode.episodeKey === sharedEpisodeKey);
    if (sharedEpisode) {
      try {
        await libraryView.openEpisode(sharedEpisode);
      } catch (error) {
        console.warn("[MSSP] Could not open shared episode.", error);
      }
    } else {
      console.warn("[MSSP] Shared episode not found.", sharedEpisodeKey);
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

init();
