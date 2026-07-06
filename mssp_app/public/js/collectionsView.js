import { formatCount, formatDateRange } from "./utils.js";
import { renderCollectionCardGlyph, renderCollectionGlyphSvg } from "./collectionGlyphs.js";

const COLLECTION_ORDER = ["old", "paytch", "new"];
const COLLECTION_NUMERALS = { old: "I", paytch: "II", new: "III" };
const COLLECTION_GLYPH_VIEWBOXES = {
  old: "7 2 17 16",
  paytch: "8 1 20 18",
  new: "12 2 17 16",
};

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
    dom.exploreGrid.innerHTML = "";
    dom.hoursSummary.innerHTML = "";
    dom.collectionGrid.innerHTML = "";

    renderHero();
    renderExplore();

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
    const publicCount = (oldCollection?.count || 0) + (newCollection?.count || 0);
    const paytchCount = paytchCollection?.count || 0;
    const episodeCount = anthology.count || publicCount + paytchCount;
    const publicShare = episodeCount ? (publicCount / episodeCount) * 100 : 50;
    const paytchShare = episodeCount ? (paytchCount / episodeCount) * 100 : 50;
    const dateRange = startYear && endYear ? `${startYear}-${endYear}` : formatDateRange(anthology);

    const hero = document.createElement("div");
    hero.className = "collection-hero-stack";
    hero.style.setProperty("--accent", anthology.accent);
    hero.style.setProperty("--public-share", `${publicShare}%`);
    hero.style.setProperty("--paytch-share", `${paytchShare}%`);
    hero.innerHTML = `
      <article class="collection-hero">
        <div class="collection-hero__art">
        <img class="collection-hero__cover" src="${anthology.coverUrl}" alt="Matt and Shane's Secret Podcast" decoding="async" width="1536" height="960">
        ${anthology.hoverCoverUrl
          ? `<img class="collection-hero__cover collection-hero__cover--hover" src="${anthology.hoverCoverUrl}" alt="" decoding="async" width="1536" height="960">`
          : ""}
        <span class="collection-hero__fade" aria-hidden="true"></span>
      </div>
      <div class="collection-hero__date">
        <img class="collection-hero__cross collection-hero__cross--date" src="./assets/icons/hero-cross.svg" alt="">
        <div class="collection-hero__rule" aria-hidden="true">
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-line"></span>
            <span class="collection-card__seal-tip"></span>
          </span>
          <strong>${dateRange}</strong>
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-tip"></span>
            <span class="collection-card__seal-line"></span>
          </span>
        </div>
      </div>
      <div class="collection-hero__copy">
        <img class="collection-hero__cross collection-hero__cross--title" src="./assets/icons/hero-cross.svg" alt="">
        <h2>${anthology.name}</h2>
        <p class="collection-hero__description">The complete chronological archive of MSSP.</p>
      </div>
        <button class="collection-hero__open" type="button">
          <img class="collection-hero__open-icon" src="./assets/icons/archive.svg" alt="">
          <span>Open Archive</span>
          <span aria-hidden="true">›</span>
        </button>
      </article>
      <section class="collection-hero__details" aria-label="Archive episode breakdown">
        <div class="collection-hero__book-rule" aria-hidden="true">
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-line"></span>
            <span class="collection-card__seal-tip"></span>
          </span>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 6.909C10.9 5.509 9.204 4.109 5.001 4.006A.494.494 0 0 0 4.5 4.5v12.097c0 .276.225.493.501.502C9.204 17.236 10.9 19.1 12 20.5m0-13.591c1.1-1.4 2.796-2.8 6.999-2.903a.494.494 0 0 1 .501.489v12.101a.5.5 0 0 1-.501.503C14.796 17.236 13.1 19.1 12 20.5m0-13.591V20.5" stroke="currentColor" stroke-linejoin="round"/>
            <path d="M19.235 6H21.5a.5.5 0 0 1 .5.5v13.039c0 .405-.477.673-.847.509a9.36 9.36 0 0 0-3.859-.785C14.353 19.263 12 21 12 21s-2.353-1.737-5.294-1.737a9.36 9.36 0 0 0-3.86.785C2.477 20.212 2 19.944 2 19.539V6.5a.5.5 0 0 1 .5-.5h2.265" stroke="currentColor" stroke-linejoin="round"/>
          </svg>
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-tip"></span>
            <span class="collection-card__seal-line"></span>
          </span>
        </div>
        <div class="collection-hero__total">
          <strong>${episodeCount.toLocaleString()}</strong><span>episodes</span>
        </div>
        <div class="collection-hero__proportion" aria-hidden="true">
          <span class="collection-hero__proportion-public"></span>
          <span class="collection-hero__proportion-paytch"></span>
        </div>
        <div class="collection-hero__legend">
          <div class="collection-hero__legend-public"><i></i><strong>${publicCount.toLocaleString()}</strong><span>public</span></div>
          <div class="collection-hero__legend-paytch"><i></i><strong>${paytchCount.toLocaleString()}</strong><span>paytch</span></div>
        </div>
      </section>
    `;
    hero.querySelector(".collection-hero__open").addEventListener("click", () => onOpenCollection(anthology.id));
    dom.launchHero.append(hero);
  }

  function renderExplore() {
    const durationByCollection = Object.fromEntries(COLLECTION_ORDER.map((id) => [id, 0]));
    let totalDurationSeconds = 0;
    for (const episode of state.archiveEpisodes) {
      const duration = Number(episode.durationSeconds) || 0;
      totalDurationSeconds += duration;
      if (episode.collectionKind in durationByCollection) {
        durationByCollection[episode.collectionKind] += duration;
      }
    }
    const totalHours = Math.round(totalDurationSeconds / 3600).toLocaleString();
    const widthDenominator = Math.max(totalDurationSeconds, 1);
    const hourSegments = COLLECTION_ORDER.map((id) => {
      const collection = state.collections.find((item) => item.id === id);
      const seconds = durationByCollection[id];
      return {
        id,
        name: collection?.name || id,
        accent: collection?.accent || "#f8f2ec",
        hours: Math.round(seconds / 3600).toLocaleString(),
        width: `${((seconds / widthDenominator) * 100).toFixed(2)}%`,
      };
    });
    const graphLabel = hourSegments
      .map((segment) => `${segment.name}: ${segment.hours} hours`)
      .join(", ");

    dom.exploreGrid.innerHTML = `
      <button class="explore-button" type="button" data-explore-action="calendar" ${state.archiveEpisodes.length ? "" : "disabled"}>Calendar</button>
      <button class="explore-button" type="button" data-explore-action="heatmap" ${state.archiveEpisodes.length ? "" : "disabled"}>Heatmap</button>
    `;

    dom.hoursSummary.innerHTML = `
      <section class="explore-total" aria-label="Archive total length">
        <div class="collection-hero__book-rule explore-total__rule" aria-hidden="true">
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-line"></span>
            <span class="collection-card__seal-tip"></span>
          </span>
          <svg class="explore-total__hourglass" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 2.5h14M5 21.5h14M7 2.5v3.672a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2.5M17 21.5v-3.672a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V21.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="collection-card__seal-arm">
            <span class="collection-card__seal-tip"></span>
            <span class="collection-card__seal-line"></span>
          </span>
        </div>
        <div class="collection-hero__total">
          <strong>${totalHours}</strong><span>total hours</span>
        </div>
        <div class="collection-hero__proportion explore-total__proportion" role="img" aria-label="${graphLabel}">
          ${hourSegments.map((segment) => `
            <span
              class="explore-total__segment"
              data-section="${segment.id}"
              style="--segment-width: ${segment.width}; --accent: ${segment.accent}"
            ></span>
          `).join("")}
        </div>
        <div class="collection-hero__legend explore-total__legend" aria-label="Hours by collection">
          ${hourSegments.map((segment) => `
            <div
              data-section="${segment.id}"
              style="--segment-width: ${segment.width}; --accent: ${segment.accent}"
            >
              <span class="explore-total__legend-core">
                ${renderCollectionGlyphSvg(
                  segment.id,
                  "explore-total__glyph",
                  COLLECTION_GLYPH_VIEWBOXES[segment.id],
                )}
                <strong>${segment.hours}</strong>
              </span>
            </div>
          `).join("")}
        </div>
      </section>
    `;

    dom.exploreGrid.querySelector('[data-explore-action="calendar"]').addEventListener("click", (event) => {
      fullCalendarModal.open(state.archiveEpisodes, event.currentTarget);
    });
    dom.exploreGrid.querySelector('[data-explore-action="heatmap"]').addEventListener("click", (event) => {
      calendarModal.open(state.archiveEpisodes, event.currentTarget);
    });
  }

  return {
    renderCollections,
    renderExplore,
    renderHero,
  };
}
