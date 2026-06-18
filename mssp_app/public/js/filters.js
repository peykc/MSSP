const FILTER_COLLECTIONS = ["old", "paytch", "new"];

const FILTER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>`;

export function createCoverFilters({ dom, state, favoritesStore, onFiltersChanged }) {
  let isOpen = false;
  let menuRoot = null;
  let toggleButton = null;
  let panel = null;
  let outsideListener = null;
  let escapeListener = null;

  function getVisibleEpisodes() {
    let episodes = state.episodes;
    if (state.favoritesOnly) {
      episodes = episodes.filter((episode) => favoritesStore.has(episode));
    }
    if (state.activeCollection?.id === "anthology" && state.selectedCoverKinds.size > 0) {
      episodes = episodes.filter((episode) => state.selectedCoverKinds.has(episode.coverKind));
    }
    return episodes;
  }

  function closeMenu() {
    if (!isOpen) return;
    isOpen = false;
    toggleButton?.setAttribute("aria-expanded", "false");
    panel?.setAttribute("hidden", "");
    document.removeEventListener("pointerdown", outsideListener, true);
    document.removeEventListener("keydown", escapeListener);
    outsideListener = null;
    escapeListener = null;
  }

  function openMenu() {
    if (isOpen) return;
    isOpen = true;
    toggleButton?.setAttribute("aria-expanded", "true");
    panel?.removeAttribute("hidden");

    outsideListener = (event) => {
      if (menuRoot?.contains(event.target)) return;
      closeMenu();
    };
    escapeListener = (event) => {
      if (event.key === "Escape") closeMenu();
    };

    document.addEventListener("pointerdown", outsideListener, true);
    document.addEventListener("keydown", escapeListener);
  }

  function toggleMenu() {
    if (isOpen) closeMenu();
    else openMenu();
  }

  function updateToggleState() {
    if (!toggleButton) return;
    const activeCount = state.selectedCoverKinds.size;
    toggleButton.classList.toggle("is-active", activeCount > 0);
    toggleButton.setAttribute("aria-label", activeCount > 0 ? `Filters (${activeCount} active)` : "Filter by section");
  }

  function updateOptionStates() {
    if (!panel) return;
    for (const button of panel.querySelectorAll("[data-kind]")) {
      const id = button.dataset.kind;
      button.setAttribute("aria-pressed", state.selectedCoverKinds.has(id) ? "true" : "false");
    }
  }

  function bindFilterMenu() {
    menuRoot = dom.coverFilters.querySelector(".filter-menu");
    toggleButton = dom.coverFilters.querySelector(".filter-menu__toggle");
    panel = dom.coverFilters.querySelector(".filter-menu__panel");

    toggleButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });

    for (const button of panel?.querySelectorAll("[data-kind]") || []) {
      button.addEventListener("click", () => {
        const id = button.dataset.kind;
        if (state.selectedCoverKinds.has(id)) state.selectedCoverKinds.delete(id);
        else state.selectedCoverKinds.add(id);
        updateToggleState();
        updateOptionStates();
        onFiltersChanged();
      });
    }
  }

  function renderCoverFilters() {
    const shouldShow = state.activeCollection?.id === "anthology" && !state.favoritesOnly;
    dom.coverFilters.classList.toggle("is-hidden", !shouldShow);

    if (!shouldShow) {
      closeMenu();
      dom.coverFilters.innerHTML = "";
      menuRoot = null;
      toggleButton = null;
      panel = null;
      return;
    }

    if (menuRoot && dom.coverFilters.contains(menuRoot)) {
      updateToggleState();
      updateOptionStates();
      return;
    }

    closeMenu();
    dom.coverFilters.innerHTML = `
      <div class="filter-menu">
        <button
          class="filter-menu__toggle"
          type="button"
          aria-expanded="false"
          aria-haspopup="true"
          aria-controls="filterMenuPanel"
          aria-label="Filter by section"
        >
          ${FILTER_ICON}
        </button>
        <div class="filter-menu__panel" id="filterMenuPanel" role="group" aria-label="Filter by section" hidden>
          <p class="filter-menu__heading">Sections</p>
          <div class="filter-menu__options">
            ${FILTER_COLLECTIONS.map((id) => {
              const collection = state.collections.find((item) => item.id === id);
              if (!collection) return "";
              return `
                <button
                  class="filter-menu__option"
                  type="button"
                  data-kind="${id}"
                  aria-pressed="false"
                >
                  <img class="filter-menu__cover" src="${collection.coverUrl}" alt="">
                  <span class="filter-menu__label">${collection.name}</span>
                </button>
              `;
            }).join("")}
          </div>
        </div>
      </div>
    `;

    bindFilterMenu();
    updateToggleState();
    updateOptionStates();
  }

  return {
    getVisibleEpisodes,
    renderCoverFilters,
    closeFilterMenu: closeMenu,
  };
}
