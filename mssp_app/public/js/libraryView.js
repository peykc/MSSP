export function createLibraryView({
  dom,
  state,
  apiClient,
  renderCoverFilters,
  closeFilterMenu,
  applyEpisodeFilters,
  clearRows,
  renderDetails,
  renderVisibleRows,
}) {
  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setLaunchCovered(covered) {
    dom.launchView.classList.toggle("is-covered", covered);
    document.body.classList.toggle("library-open", covered);
    dom.launchView.inert = covered;
    if (covered) {
      dom.launchView.setAttribute("aria-hidden", "true");
    } else {
      dom.launchView.removeAttribute("aria-hidden");
    }
  }

  function revealLibrary() {
    dom.libraryView.classList.remove("is-hidden", "is-leaving");
    if (prefersReducedMotion()) return;

    dom.libraryView.classList.add("is-entering");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        dom.libraryView.classList.remove("is-entering");
      });
    });
  }

  async function openCollection(id) {
    state.favoritesOnly = false;
    return openLibrary(id);
  }

  async function openFavorites() {
    state.favoritesOnly = true;
    return openLibrary("anthology");
  }

  async function openEpisode(episode) {
    if (!episode) return;
    state.favoritesOnly = false;
    await openLibrary("anthology");

    const matched = state.episodes.find((item) => item.episodeKey === episode.episodeKey)
      || state.episodes.find((item) => item.id === episode.id);
    if (!matched) return;

    state.selectedEpisodeId = matched.id;
    applyEpisodeFilters({ resetSelection: false });
    const index = state.visibleEpisodes.findIndex((item) => item.id === matched.id);
    if (index >= 0) {
      const rowHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row")) || 64;
      const targetTop = index * rowHeight;
      const maxScroll = Math.max(0, state.visibleEpisodes.length * rowHeight - dom.episodeList.clientHeight);
      dom.episodeList.scrollTop = Math.max(0, Math.min(targetTop - dom.episodeList.clientHeight * 0.28, maxScroll));
    }
    renderDetails();
    renderVisibleRows();
  }

  async function openLibrary(id) {
    state.activeCollection = state.collections.find((item) => item.id === id);
    if (!state.activeCollection) return;

    setLaunchCovered(true);
    revealLibrary();

    dom.heroCover.src = state.activeCollection.coverUrl;
    dom.heroCover.alt = `${state.activeCollection.name} cover`;
    dom.panelTitle.textContent = state.favoritesOnly ? "Favorites" : state.activeCollection.name;
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

  function resetLibraryState() {
    state.episodes = [];
    state.visibleEpisodes = [];
    state.selectedCoverKinds = new Set();
    state.favoritesOnly = false;
    clearRows();
    closeFilterMenu?.();
    dom.coverFilters.innerHTML = "";
  }

  function finishClose() {
    dom.libraryView.classList.remove("is-leaving");
    dom.libraryView.classList.add("is-hidden");
    setLaunchCovered(false);
    resetLibraryState();
  }

  function closeLibrary() {
    if (dom.libraryView.classList.contains("is-hidden")) return;

    if (prefersReducedMotion()) {
      finishClose();
      return;
    }

    dom.libraryView.classList.add("is-leaving");
    const onTransitionEnd = (event) => {
      if (event.target !== dom.libraryView || event.propertyName !== "transform") return;
      dom.libraryView.removeEventListener("transitionend", onTransitionEnd);
      finishClose();
    };
    dom.libraryView.addEventListener("transitionend", onTransitionEnd);
  }

  return {
    closeLibrary,
    loadEpisodes,
    openCollection,
    openFavorites,
    openEpisode,
  };
}
