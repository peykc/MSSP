import { createCollectionsView } from "./collectionsView.js";
import { dom } from "./dom.js";
import { createEpisodeDetails } from "./episodeDetails.js";
import { createEpisodeList } from "./episodeList.js";
import { createCoverFilters } from "./filters.js";
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
  });
  createMediaSessionController({ playerState, audioController });
  const queueCache = new Map();

  let episodeList;
  const episodeDetails = createEpisodeDetails({
    dom,
    state,
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
    onOpenCollection: libraryView.openCollection,
  });

  dom.episodeList.addEventListener("scroll", episodeList.renderVisibleRows, { passive: true });
  window.addEventListener("resize", () => {
    collectionsView.updateCollectionCoverSizes();
    episodeList.renderVisibleRows();
    episodeDetails.updateHeroCoverSize();
    episodeDetails.updateHeroTitleMarquee();
  });
  dom.backButton.addEventListener("click", libraryView.closeLibrary);
  initSearch({ dom, state, loadEpisodes: libraryView.loadEpisodes });

  const data = await apiClient.getCollections();
  console.info("[MSSP] Data mode:", apiClient.getMode());
  state.collections = data.collections;
  collectionsView.renderCollections();
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

init().catch((error) => {
  console.error("[MSSP] Failed to start frontend.", error);
});
