import { createCollectionsView } from "./collectionsView.js";
import { dom } from "./dom.js";
import { createEpisodeDetails } from "./episodeDetails.js";
import { createEpisodeList } from "./episodeList.js";
import { createCoverFilters } from "./filters.js";
import { createLibraryView } from "./libraryView.js";
import { initSearch } from "./search.js";
import { createAppState } from "./state.js";
import { initGlobalTooltip } from "./tooltip.js";

function getApiClient() {
  if (!window.MsspApiClient) {
    throw new Error("[MSSP] MsspApiClient is unavailable. Ensure ./js/apiClient.js loads before ./js/main.js.");
  }
  return window.MsspApiClient;
}

async function init() {
  const apiClient = getApiClient();
  const state = createAppState();
  const dismissGlobalTooltip = initGlobalTooltip();
  const episodeDetails = createEpisodeDetails({ dom, state });

  let coverFilters;
  const episodeList = createEpisodeList({
    dom,
    state,
    getVisibleEpisodes: () => coverFilters.getVisibleEpisodes(),
    renderDetails: episodeDetails.renderDetails,
    dismissGlobalTooltip,
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
}

init().catch((error) => {
  console.error("[MSSP] Failed to start frontend.", error);
});
