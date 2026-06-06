const FILTER_COLLECTIONS = ["old", "paytch", "new"];

export function createCoverFilters({ dom, state, onFiltersChanged }) {
  function getVisibleEpisodes() {
    if (state.activeCollection?.id !== "anthology" || state.selectedCoverKinds.size === 0) {
      return state.episodes;
    }

    return state.episodes.filter((episode) => state.selectedCoverKinds.has(episode.coverKind));
  }

  function renderCoverFilters() {
    dom.coverFilters.innerHTML = "";
    const shouldShow = state.activeCollection?.id === "anthology";
    dom.coverFilters.classList.toggle("is-hidden", !shouldShow);
    if (!shouldShow) return;

    for (const id of FILTER_COLLECTIONS) {
      const collection = state.collections.find((item) => item.id === id);
      if (!collection) continue;

      const button = document.createElement("button");
      button.className = "cover-filter";
      button.type = "button";
      button.setAttribute("aria-pressed", state.selectedCoverKinds.has(id) ? "true" : "false");
      button.setAttribute("aria-label", `Toggle ${collection.name}`);
      button.dataset.kind = id;
      button.innerHTML = `<img src="${collection.coverUrl}" alt="">`;
      button.addEventListener("click", () => {
        if (state.selectedCoverKinds.has(id)) state.selectedCoverKinds.delete(id);
        else state.selectedCoverKinds.add(id);
        renderCoverFilters();
        onFiltersChanged();
      });
      dom.coverFilters.append(button);
    }
  }

  return {
    getVisibleEpisodes,
    renderCoverFilters,
  };
}
