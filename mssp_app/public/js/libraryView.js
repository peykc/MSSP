export function createLibraryView({
  dom,
  state,
  apiClient,
  renderCoverFilters,
  applyEpisodeFilters,
  clearRows,
  renderDetails,
  renderVisibleRows,
}) {
  async function openCollection(id) {
    state.activeCollection = state.collections.find((item) => item.id === id);
    if (!state.activeCollection) return;

    dom.launchView.classList.add("is-hidden");
    dom.libraryView.classList.remove("is-hidden");
    dom.libraryView.classList.add("is-entering");
    requestAnimationFrame(() => dom.libraryView.classList.remove("is-entering"));

    dom.heroCover.src = state.activeCollection.coverUrl;
    dom.heroCover.alt = `${state.activeCollection.name} cover`;
    dom.panelTitle.textContent = state.activeCollection.name;
    dom.searchInput.value = "";
    state.query = "";
    state.selectedCoverKinds = new Set();
    renderCoverFilters();
    await loadEpisodes();
  }

  async function loadEpisodes() {
    const data = await apiClient.getEpisodes({
      collection: state.activeCollection.id,
      query: state.query,
    });
    state.episodes = data.episodes;
    clearRows();
    applyEpisodeFilters({ resetSelection: true });
    dom.episodeList.scrollTop = 0;
    renderDetails();
    renderVisibleRows();
  }

  function closeLibrary() {
    dom.libraryView.classList.add("is-hidden");
    dom.launchView.classList.remove("is-hidden");
    state.episodes = [];
    state.visibleEpisodes = [];
    state.selectedCoverKinds = new Set();
    clearRows();
    dom.coverFilters.innerHTML = "";
  }

  return {
    closeLibrary,
    loadEpisodes,
    openCollection,
  };
}
