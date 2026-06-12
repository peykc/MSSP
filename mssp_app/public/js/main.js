import { createArchiveStatsView } from "./archiveStats.js";
import { createCalendarModal } from "./calendarModal.js";
import { createCollectionsView } from "./collectionsView.js";
import { dom } from "./dom.js";
import { createEpisodeDetails } from "./episodeDetails.js";
import { createEpisodeList } from "./episodeList.js";
import { createCoverFilters } from "./filters.js";
import { createFavoritesStore } from "./favoritesStore.js";
import { createLibraryView } from "./libraryView.js";
import { createAudioController } from "./player/audioController.js";
import { createMediaSessionController } from "./player/mediaSessionController.js";
import { createPlayerState } from "./player/playerState.js";
import { createPlayerView } from "./player/playerView.js";
import { getSourceStatus } from "./player/sourceStatus.js";
import { registerServiceWorker } from "./pwa.js";
import { initSearch } from "./search.js";
import { getPublicSourceForEpisode, loadPublicSources } from "./sources/publicSources.js";
import { createAppState } from "./state.js";
import { initGlobalTooltip } from "./tooltip.js";

function getApiClient() {
  if (!window.MsspApiClient) {
    throw new Error("[MSSP] MsspApiClient is unavailable. Ensure ./js/apiClient.js loads before ./js/main.js.");
  }
  return window.MsspApiClient;
}

async function init() {
  registerServiceWorker();
  const apiClient = getApiClient();
  const state = createAppState();
  const favoritesStore = createFavoritesStore();
  const calendarModal = createCalendarModal({ dom });
  const archiveStatsView = createArchiveStatsView({ dom, state });
  const dismissGlobalTooltip = initGlobalTooltip();
  await loadPublicSources();
  const getSourceStatusForEpisode = (episode) => getSourceStatus(episode, getPublicSourceForEpisode(episode));
  const playerState = createPlayerState({ getPublicSourceForEpisode });
  const audioController = createAudioController({
    playerState,
    onEnded: handleEnded,
  });
  createPlayerView({
    dom,
    playerState,
    audioController,
    favoritesStore,
  });
  createMediaSessionController({ playerState, audioController });
  const queueCache = new Map();

  let episodeList;
  const episodeDetails = createEpisodeDetails({
    dom,
    state,
    favoritesStore,
    onPlayRequest: requestPlay,
    getSourceStatusForEpisode,
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
    onOpenCollection: libraryView.openCollection,
    onOpenFavorites: libraryView.openFavorites,
  });

  dom.episodeList.addEventListener("scroll", episodeList.renderVisibleRows, { passive: true });
  window.addEventListener("resize", () => {
    episodeList.renderVisibleRows();
    episodeDetails.updateHeroCoverSize();
    episodeDetails.updateHeroTitleMarquee();
  });
  dom.backButton.addEventListener("click", libraryView.closeLibrary);
  initSearch({ dom, state, loadEpisodes: libraryView.loadEpisodes });

  const [data, archiveResult] = await Promise.all([
    apiClient.getCollections(),
    apiClient.getEpisodes({ collection: "anthology", query: "" })
      .then((value) => ({ value }))
      .catch((error) => ({ error })),
  ]);
  console.info("[MSSP] Data mode:", apiClient.getMode());
  state.collections = data.collections;
  if (archiveResult.value) {
    const archiveEpisodes = archiveResult.value.episodes || [];
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

  async function requestPlay(episode) {
    state.selectedEpisodeId = episode.id;
    episodeDetails.renderDetails();
    episodeList.renderVisibleRows();

    const collectionId = state.activeCollection?.id || episode.collectionKind || "anthology";
    let queue = queueCache.get(collectionId);
    if (!queue && state.activeCollection?.id === collectionId && !state.query) {
      queue = state.episodes;
      queueCache.set(collectionId, queue);
    }

    playerState.loadEpisode({ episode, collectionId, queue: queue || [], isExpanded: false });
    void audioController.loadSelected({ playbackIntent: Boolean(getPublicSourceForEpisode(episode)) });

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

  function stepPlayer(offset, { playbackIntent = true } = {}) {
    const episode = playerState.step(offset);
    if (!episode) return;
    audioController.loadSelected({ playbackIntent });
  }

  function handleEnded() {
    if (!playerState.getQueuePosition().hasNext) return;
    stepPlayer(1, { playbackIntent: true });
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
  console.error("[MSSP] Failed to start frontend.", error);
});
