import { formatCount, formatDateRange } from "./utils.js";
import { renderCollectionCardGlyph } from "./collectionGlyphs.js";

const COLLECTION_ORDER = ["old", "paytch", "new"];
const COLLECTION_NUMERALS = { old: "I", paytch: "II", new: "III" };

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
          <img class="collection-card__cover" src="${collection.coverUrl}" alt="" decoding="async" width="768" height="768">
        </span>
        <span class="collection-card__relic">
          <span class="collection-card__seal" aria-hidden="true">
            <span class="collection-card__seal-arm">
              <span class="collection-card__seal-line"></span>
              <span class="collection-card__seal-tip"></span>
            </span>
            <span class="collection-card__numeral">${COLLECTION_NUMERALS[id] || ""}</span>
            <span class="collection-card__seal-arm">
              <span class="collection-card__seal-tip"></span>
              <span class="collection-card__seal-line"></span>
            </span>
          </span>
          <span class="collection-card__copy">
            <h2>${collection.name}</h2>
            <p>${formatCount(collection.count)}</p>
          </span>
          ${renderCollectionCardGlyph(id)}
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
        <img class="collection-hero__cover" src="${anthology.coverUrl}" alt="" decoding="async" width="1536" height="960">
        ${anthology.hoverCoverUrl
          ? `<img class="collection-hero__cover collection-hero__cover--hover" src="${anthology.hoverCoverUrl}" alt="" decoding="async" width="1536" height="960">`
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