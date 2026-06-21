import { createArchiveStatsView } from "./archiveStats.js";
import { createCalendarModal } from "./calendarModal.js";
import { createFullCalendarModal } from "./fullCalendarModal.js";
import { createCollectionsView } from "./collectionsView.js";
import { dom } from "./dom.js";
import { createEpisodeDetails } from "./episodeDetails.js";
import { createEpisodeList } from "./episodeList.js";
import { createCoverFilters } from "./filters.js";
import { createFavoritesStore } from "./favoritesStore.js";
import { createLibraryView } from "./libraryView.js";
import { createAudioController } from "./player/audioController.js";
import { createMediaSessionController } from "./player/mediaSessionController.js";
import { createPatreonRssModal } from "./patreonRssModal.js";
import { createPlaybackProgressStore } from "./player/playbackProgressStore.js";
import { createPlayerState } from "./player/playerState.js";
import { createPlayerView } from "./player/playerView.js";
import { getSourceStatus, SOURCE_STATUSES } from "./player/sourceStatus.js";
import { registerServiceWorker, initPwaUpdates } from "./pwa.js";
import { initSearch } from "./search.js";
import { getPublicSourceForEpisode, loadPublicSources } from "./sources/publicSources.js";
import { createPatreonRssSources } from "./sources/patreonRssSources.js";
import { createAppState } from "./state.js";
import { initGlobalTooltip } from "./tooltip.js";
import { dismissLaunchSplash } from "./launchSplash.js";

function getApiClient() {
  if (!window.MsspApiClient) {
    throw new Error("[MSSP] MsspApiClient is unavailable. Ensure ./js/apiClient.js loads before ./js/main.js.");
  }
  return window.MsspApiClient;
}

async function init() {
  void registerServiceWorker().then((registration) => {
    if (registration) initPwaUpdates(registration);
  });
  const apiClient = getApiClient();
  const state = createAppState();
  const favoritesStore = createFavoritesStore();
  const calendarModal = createCalendarModal({ dom });
  const fullCalendarModal = createFullCalendarModal({ dom });
  const archiveStatsView = createArchiveStatsView({ dom, state, fullCalendarModal });
  const dismissGlobalTooltip = initGlobalTooltip();
  await loadPublicSources();
  const patreonSources = createPatreonRssSources();
  const getSourceForEpisode = (episode) => patreonSources.getSourceForEpisode(episode) || getPublicSourceForEpisode(episode);
  const getSourceStatusForEpisode = (episode) => getSourceStatus(episode, getSourceForEpisode(episode));
  const playerState = createPlayerState({ getPublicSourceForEpisode: getSourceForEpisode });
  let episodeList;
  let patreonRssModal;
  let archiveEpisodes = [];
  let refreshQueueProgress = null;
  const playbackProgressStore = createPlaybackProgressStore({
    onChange: () => {
      if (!dom.libraryView.classList.contains("is-hidden")) {
        episodeList?.renderVisibleRows();
      }
      refreshQueueProgress?.();
    },
  });
  const queueCache = new Map();

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

  function stepPlayer(offset, { playbackIntent = true } = {}) {
    if (offset <= 0) {
      const episode = playerState.step(offset);
      if (!episode) return;
      void audioController.loadSelected({ playbackIntent });
      return;
    }

    const playerSnapshot = playerState.getState();
    const fromEpisode = playerSnapshot.selectedEpisode;
    if (!fromEpisode) return;

    const nextEpisode = playerState.getNextPlayableEpisode(
      fromEpisode.episodeKey,
      (episode) => playbackProgressStore.getEpisodeProgress(episode.episodeKey).status !== "completed",
    );
    if (!nextEpisode) return;

    playerState.loadEpisode({
      episode: nextEpisode,
      collectionId: playerSnapshot.collectionId,
      queue: playerSnapshot.queue,
      isExpanded: playerSnapshot.isExpanded,
    });
    void audioController.loadSelected({ playbackIntent });
  }

  function handleEnded() {
    stepPlayer(1, { playbackIntent: true });
  }

  const audioController = createAudioController({
    playerState,
    playbackProgressStore,
    onEnded: handleEnded,
  });
  createPlayerView({
    dom,
    playerState,
    audioController,
    favoritesStore,
    playbackProgressStore,
    getSourceStatusForEpisode,
    onSelectRequest: requestSelect,
    onPlayRequest: requestPlay,
    onLockedRequest: (_episode, trigger) => patreonRssModal?.open(trigger),
    onRegisterQueueRefresh: (fn) => {
      refreshQueueProgress = fn;
    },
  });
  createMediaSessionController({ playerState, audioController });

  const episodeDetails = createEpisodeDetails({
    dom,
    state,
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
  initSearch({ dom, state, loadEpisodes: libraryView.loadEpisodes });

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
      favoritesStore.retain(new Set(archiveEpisodes.map((episode) => episode.episodeKey)));
      archiveStatsView.setEpisodes(archiveEpisodes);
    } else {
      console.error("[MSSP] Could not load archive statistics.", archiveResult.error);
      archiveStatsView.renderError();
    }
    collectionsView.renderCollections();
    void logMetadataDiagnostics(apiClient);

    favoritesStore.subscribe(() => {
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
        .catch(() => {});
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  } catch (error) {
    console.error("[MSSP] Failed to start frontend.", error);
  } finally {
    dismissLaunchSplash();
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
