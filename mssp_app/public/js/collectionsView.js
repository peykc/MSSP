import { formatCount, formatDateRange } from "./utils.js";

const COLLECTION_ORDER = ["anthology", "new", "old", "paytch"];

export function createCollectionsView({ dom, state, onOpenCollection }) {
  function renderCollections() {
    dom.collectionGrid.innerHTML = "";

    for (const id of COLLECTION_ORDER) {
      const collection = state.collections.find((item) => item.id === id);
      if (!collection) continue;

      const button = document.createElement("button");
      button.className = `collection-card ${id === "anthology" ? "collection-card--anthology" : ""}`;
      button.type = "button";
      button.style.setProperty("--accent", collection.accent);
      const hoverCover = collection.hoverCoverUrl
        ? `<img class="collection-card__cover collection-card__cover--hover" src="${collection.hoverCoverUrl}" alt="">`
        : "";
      button.innerHTML = `
        <span class="collection-card__art">
          <img class="collection-card__cover" src="${collection.coverUrl}" alt="">
          ${hoverCover}
        </span>
        <span class="collection-card__copy">
          <span class="eyebrow">${formatDateRange(collection)}</span>
          <h2>${collection.name}</h2>
          <p>${formatCount(collection.count)}</p>
        </span>
      `;
      button.addEventListener("click", () => onOpenCollection(collection.id));
      dom.collectionGrid.append(button);
    }

    requestAnimationFrame(updateCollectionCoverSizes);
  }

  function updateCollectionCoverSizes() {
    const portraitLayout = window.matchMedia("(max-aspect-ratio: 7 / 6)").matches;
    if (portraitLayout) {
      const cards = [...dom.collectionGrid.querySelectorAll(".collection-card")];
      const firstCard = cards[0];
      if (!firstCard || cards.length === 0) return;

      const gridStyle = window.getComputedStyle(dom.collectionGrid);
      const cardStyle = window.getComputedStyle(firstCard);
      const rowGap = parseFloat(gridStyle.rowGap) || 0;
      const verticalPadding = (parseFloat(cardStyle.paddingTop) || 0)
        + (parseFloat(cardStyle.paddingBottom) || 0);
      const horizontalPadding = (parseFloat(cardStyle.paddingLeft) || 0)
        + (parseFloat(cardStyle.paddingRight) || 0);
      const rowHeight = (dom.collectionGrid.clientHeight - (rowGap * (cards.length - 1))) / cards.length;
      const maxByHeight = rowHeight - verticalPadding;
      const maxByWidth = (firstCard.clientWidth - horizontalPadding) * 0.34;
      const size = Math.max(64, Math.min(190, maxByHeight, maxByWidth));

      dom.collectionGrid.style.setProperty("--collection-card-cover-size", `${size}px`);
      for (const card of cards) {
        card.querySelector(".collection-card__art")?.style.removeProperty("--collection-cover-size");
      }
      return;
    }

    dom.collectionGrid.style.removeProperty("--collection-card-cover-size");
    for (const card of dom.collectionGrid.querySelectorAll(".collection-card:not(.collection-card--anthology)")) {
      const art = card.querySelector(".collection-card__art");
      const copy = card.querySelector(".collection-card__copy");
      if (!art || !copy) continue;

      const cardStyle = window.getComputedStyle(card);
      const innerWidth = card.clientWidth
        - parseFloat(cardStyle.paddingLeft)
        - parseFloat(cardStyle.paddingRight);
      const innerHeight = card.clientHeight
        - parseFloat(cardStyle.paddingTop)
        - parseFloat(cardStyle.paddingBottom);
      const copyHeight = copy.offsetHeight;
      const copyPaddingTop = parseFloat(window.getComputedStyle(copy).paddingTop) || 0;
      const availableHeight = innerHeight - copyHeight - copyPaddingTop;
      const size = Math.max(72, Math.min(innerWidth, availableHeight));
      art.style.setProperty("--collection-cover-size", `${size}px`);
    }
  }

  return {
    renderCollections,
    updateCollectionCoverSizes,
  };
}
