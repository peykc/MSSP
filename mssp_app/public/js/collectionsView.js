import { formatCount, formatDateRange } from "./utils.js";

const COLLECTION_ORDER = ["old", "new", "paytch"];

export function createCollectionsView({
  dom,
  state,
  favoritesStore,
  calendarModal,
  fullCalendarModal,
  onOpenCollection,
  onOpenFavorites,
}) {
  function renderCollections() {
    dom.launchHero.innerHTML = "";
    dom.collectionGrid.innerHTML = "";

    renderHero();

    for (const id of COLLECTION_ORDER) {
      const collection = state.collections.find((item) => item.id === id);
      if (!collection) continue;

      const button = document.createElement("button");
      button.className = "collection-card";
      button.type = "button";
      button.style.setProperty("--accent", collection.accent);
      button.innerHTML = `
        <span class="collection-card__art">
          <img class="collection-card__cover" src="${collection.coverUrl}" alt="">
        </span>
        <span class="collection-card__copy">
          <span class="eyebrow">${formatDateRange(collection)}</span>
          <h2>${collection.name}</h2>
          <p>${formatCount(collection.count)}</p>
          <span class="collection-card__browse" aria-hidden="true">Browse <span>›</span></span>
        </span>
      `;
      button.addEventListener("click", () => onOpenCollection(collection.id));
      dom.collectionGrid.append(button);
    }
  }

  function renderHero() {
    dom.launchHero.innerHTML = "";
    const anthology = state.collections.find((item) => item.id === "anthology");
    if (!anthology) return;

    const oldCollection = state.collections.find((item) => item.id === "old");
    const newCollection = state.collections.find((item) => item.id === "new");
    const paytchCollection = state.collections.find((item) => item.id === "paytch");
    const startYear = Number(anthology.startDate?.slice(0, 4));
    const endYear = Number(anthology.endDate?.slice(0, 4));
    const yearCount = startYear && endYear ? endYear - startYear + 1 : null;
    const publicCount = (oldCollection?.count || 0) + (newCollection?.count || 0);

    const hero = document.createElement("article");
    hero.className = "collection-hero";
    hero.style.setProperty("--accent", anthology.accent);
    hero.innerHTML = `
      <span class="collection-hero__art">
        <img class="collection-hero__cover" src="${anthology.coverUrl}" alt="">
        ${anthology.hoverCoverUrl
          ? `<img class="collection-hero__cover collection-hero__cover--hover" src="${anthology.hoverCoverUrl}" alt="">`
          : ""}
      </span>
      <div class="collection-hero__copy">
        <span class="eyebrow">${formatDateRange(anthology)}</span>
        <h2>${anthology.name}</h2>
        <p class="collection-hero__description">The complete chronological archive of MSSP.</p>
        <dl class="collection-hero__stats">
          <div><dt>${anthology.count.toLocaleString()}</dt><dd>episodes</dd></div>
          ${yearCount ? `<div><dt>${yearCount}</dt><dd>years</dd></div>` : ""}
          <div><dt>${publicCount.toLocaleString()}</dt><dd>public</dd></div>
          <div><dt>${(paytchCollection?.count || 0).toLocaleString()}</dt><dd>paytch</dd></div>
        </dl>
        <button class="collection-hero__open" type="button">
          <img class="collection-hero__open-icon" src="./assets/icons/archive.svg" alt="">
          <span>Open Archive</span>
          <span aria-hidden="true">›</span>
        </button>
        <div class="collection-hero__actions" role="group" aria-label="Archive tools">
          <button type="button" data-hero-action="heatmap" ${state.archiveEpisodes.length ? "" : "disabled"}>Heatmap</button>
          <button type="button" data-hero-action="calendar" ${state.archiveEpisodes.length ? "" : "disabled"}>Calendar</button>
          <button type="button" data-hero-action="stats">Stats</button>
          ${favoritesStore.getCount() > 0
            ? `<button type="button" data-hero-action="favorites">Favorites &middot; ${favoritesStore.getCount()}</button>`
            : ""}
        </div>
      </div>
    `;
    hero.querySelector(".collection-hero__open").addEventListener("click", () => onOpenCollection(anthology.id));
    hero.querySelector('[data-hero-action="heatmap"]').addEventListener("click", (event) => {
      calendarModal.open(state.archiveEpisodes, event.currentTarget);
    });
    hero.querySelector('[data-hero-action="calendar"]').addEventListener("click", (event) => {
      fullCalendarModal.open(state.archiveEpisodes, event.currentTarget);
    });
    hero.querySelector('[data-hero-action="stats"]').addEventListener("click", () => {
      dom.archiveStats.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    hero.querySelector('[data-hero-action="favorites"]')?.addEventListener("click", onOpenFavorites);
    dom.launchHero.append(hero);
  }

  return {
    renderCollections,
    renderHero,
  };
}
