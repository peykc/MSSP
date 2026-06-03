const collectionGrid = document.getElementById("collectionGrid");
const launchView = document.getElementById("launchView");
const libraryView = document.getElementById("libraryView");
const heroCover = document.getElementById("heroCover");
const heroDetails = document.getElementById("heroDetails");
const panelTitle = document.getElementById("panelTitle");
const searchInput = document.getElementById("searchInput");
const coverFilters = document.getElementById("coverFilters");
const episodeList = document.getElementById("episodeList");
const listSpacer = document.getElementById("listSpacer");
const listItems = document.getElementById("listItems");
const backButton = document.getElementById("backButton");

const ROW_HEIGHT = 64;
const OVERSCAN = 8;
const rowCache = new Map();

let collections = [];
let activeCollection = null;
let episodes = [];
let visibleEpisodes = [];
let selectedEpisodeId = null;
let query = "";
let selectedCoverKinds = new Set();

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function formatCount(count) {
  return `${count.toLocaleString()} episode${count === 1 ? "" : "s"}`;
}

function formatDateRange(collection) {
  if (!collection.startDate || !collection.endDate) return formatCount(collection.count);
  const startYear = collection.startDate.slice(0, 4);
  const endYear = collection.endDate.slice(0, 4);
  return startYear === endYear ? startYear : `${startYear} - ${endYear}`;
}

function renderCollections() {
  collectionGrid.innerHTML = "";
  const order = ["anthology", "new", "old", "paytch"];
  for (const id of order) {
    const collection = collections.find((item) => item.id === id);
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
    button.addEventListener("click", () => openCollection(collection.id));
    collectionGrid.append(button);
  }
}

async function openCollection(id) {
  activeCollection = collections.find((item) => item.id === id);
  if (!activeCollection) return;

  launchView.classList.add("is-hidden");
  libraryView.classList.remove("is-hidden");
  libraryView.classList.add("is-entering");
  requestAnimationFrame(() => libraryView.classList.remove("is-entering"));

  heroCover.src = activeCollection.coverUrl;
  heroCover.alt = `${activeCollection.name} cover`;
  panelTitle.textContent = activeCollection.name;
  searchInput.value = "";
  query = "";
  selectedCoverKinds = new Set();
  renderCoverFilters();
  await loadEpisodes();
}

async function loadEpisodes() {
  const url = new URL("/api/episodes", window.location.origin);
  url.searchParams.set("collection", activeCollection.id);
  if (query) url.searchParams.set("q", query);
  const data = await getJson(url);
  episodes = data.episodes;
  rowCache.clear();
  listItems.innerHTML = "";
  applyEpisodeFilters({ resetSelection: true });
  episodeList.scrollTop = 0;
  renderDetails();
  renderVisibleRows();
}

function getVisibleEpisodes() {
  if (activeCollection?.id !== "anthology" || selectedCoverKinds.size === 0) return episodes;
  return episodes.filter((episode) => selectedCoverKinds.has(episode.coverKind));
}

function applyEpisodeFilters({ resetSelection = false, preserveScroll = false } = {}) {
  const previousScrollTop = episodeList.scrollTop;
  const anchorIndex = Math.floor(previousScrollTop / ROW_HEIGHT);
  const anchorOffset = previousScrollTop - anchorIndex * ROW_HEIGHT;
  const anchorEpisode = preserveScroll ? visibleEpisodes[anchorIndex] : null;

  visibleEpisodes = getVisibleEpisodes();
  const selectedIsVisible = visibleEpisodes.some((episode) => episode.id === selectedEpisodeId);
  if (resetSelection || !selectedIsVisible) {
    selectedEpisodeId = visibleEpisodes[0]?.id ?? null;
  }
  rowCache.clear();
  listItems.innerHTML = "";
  listSpacer.style.height = `${visibleEpisodes.length * ROW_HEIGHT}px`;

  if (!preserveScroll) return;

  const anchorNewIndex = anchorEpisode
    ? visibleEpisodes.findIndex((episode) => episode.id === anchorEpisode.id)
    : -1;
  const maxScrollTop = Math.max(0, visibleEpisodes.length * ROW_HEIGHT - episodeList.clientHeight);
  const nextScrollTop = anchorNewIndex >= 0
    ? anchorNewIndex * ROW_HEIGHT + anchorOffset
    : Math.min(previousScrollTop, maxScrollTop);
  episodeList.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
  window.MsspAnthology?.dismissGlobalTooltip?.();
}

function renderCoverFilters() {
  coverFilters.innerHTML = "";
  const shouldShow = activeCollection?.id === "anthology";
  coverFilters.classList.toggle("is-hidden", !shouldShow);
  if (!shouldShow) return;

  for (const id of ["old", "paytch", "new"]) {
    const collection = collections.find((item) => item.id === id);
    if (!collection) continue;

    const button = document.createElement("button");
    button.className = "cover-filter";
    button.type = "button";
    button.setAttribute("aria-pressed", selectedCoverKinds.has(id) ? "true" : "false");
    button.setAttribute("aria-label", `Toggle ${collection.name}`);
    button.dataset.kind = id;
    button.innerHTML = `<img src="${collection.coverUrl}" alt="">`;
    button.addEventListener("click", () => {
      if (selectedCoverKinds.has(id)) selectedCoverKinds.delete(id);
      else selectedCoverKinds.add(id);
      renderCoverFilters();
      applyEpisodeFilters({ preserveScroll: true });
      renderDetails();
      renderVisibleRows();
    });
    coverFilters.append(button);
  }
}

function renderVisibleRows() {
  const viewportHeight = episodeList.clientHeight;
  const scrollTop = episodeList.scrollTop;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visibleEpisodes.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleKeys = new Set();

  for (let index = start; index < end; index += 1) {
    const episode = visibleEpisodes[index];
    const key = episode.id;
    visibleKeys.add(key);
    const row = getMemoizedRow(episode);
    row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    row.classList.toggle("is-selected", episode.id === selectedEpisodeId);
    if (row.parentElement !== listItems) listItems.append(row);
  }

  for (const child of [...listItems.children]) {
    const key = Number(child.dataset.id);
    if (!visibleKeys.has(key)) child.remove();
  }
}

function getMemoizedRow(episode) {
  if (rowCache.has(episode.id)) return rowCache.get(episode.id);

  const row = document.createElement("button");
  row.className = "episode-row";
  row.type = "button";
  row.dataset.id = episode.id;
  row.innerHTML = `
    <img src="${episode.coverUrl}" alt="">
    <span class="episode-row__main">
      <span class="episode-row__line">
        <span class="episode-row__episode"></span>
        <span class="episode-row__title"></span>
      </span>
    </span>
    <span class="episode-row__date"></span>
  `;
  const title = episode.title || "Untitled episode";
  const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
  const titleEl = row.querySelector(".episode-row__title");
  row.querySelector(".episode-row__episode").textContent = episodeLabel;
  titleEl.textContent = title;
  row.querySelector(".episode-row__date").textContent = episode.date || "";
  row.addEventListener("click", () => {
    selectedEpisodeId = episode.id;
    renderDetails();
    renderVisibleRows();
  });
  rowCache.set(episode.id, row);
  return row;
}

function renderDetails() {
  const episode = visibleEpisodes.find((item) => item.id === selectedEpisodeId);
  if (!episode) {
    heroCover.src = activeCollection.coverUrl;
    heroCover.alt = `${activeCollection.name} cover`;
    heroDetails.innerHTML = "<span>No episodes match this view.</span>";
    return;
  }

  heroCover.src = episode.coverUrl;
  heroCover.alt = `${episode.title || "Selected episode"} cover`;
  const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
  const accessLabel = episode.paytch ? "PAYTCH" : "Public";
  heroDetails.innerHTML = `
    <span class="hero-details__heading">
      <span class="hero-details__heading-inner">
        <span class="hero-details__episode">${episodeLabel}</span>
        <span class="hero-details__title">
          <span class="hero-details__title-text">${episode.title || "Untitled episode"}</span>
        </span>
      </span>
    </span>
    <span>${episode.type || "MSSP"} - ${accessLabel}</span>
    <span>${episode.date || "Unknown date"}</span>
  `;
  requestAnimationFrame(updateHeroTitleMarquee);
}

function updateHeroTitleMarquee() {
  const title = heroDetails.querySelector(".hero-details__title");
  const titleText = heroDetails.querySelector(".hero-details__title-text");
  if (!title || !titleText) return;

  titleText.getAnimations().forEach((animation) => animation.cancel());
  titleText.style.transform = "";
  titleText.style.opacity = "";
  title.classList.remove("is-marquee");
  title.style.removeProperty("--marquee-distance");
  title.style.removeProperty("--marquee-duration");

  const distance = titleText.scrollWidth - title.clientWidth;
  if (distance <= 2) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const holdMs = 1000;
  const fadeMs = 280;
  const resetMs = 120;
  const speedPxPerSecond = 42;
  const scrollMs = Math.max(4200, Math.min(18000, (distance / speedPxPerSecond) * 1000));
  const duration = holdMs + scrollMs + holdMs + fadeMs + resetMs + fadeMs;

  title.style.setProperty("--marquee-distance", `${distance}px`);
  title.style.setProperty("--marquee-duration", `${duration}ms`);
  title.classList.add("is-marquee");

  titleText.animate(
    [
      { transform: "translateX(0)", opacity: 1, offset: 0 },
      { transform: "translateX(0)", opacity: 1, offset: holdMs / duration },
      {
        transform: `translateX(${-distance}px)`,
        opacity: 1,
        offset: (holdMs + scrollMs) / duration,
      },
      {
        transform: `translateX(${-distance}px)`,
        opacity: 1,
        offset: (holdMs + scrollMs + holdMs) / duration,
      },
      {
        transform: `translateX(${-distance}px)`,
        opacity: 0,
        offset: (holdMs + scrollMs + holdMs + fadeMs) / duration,
      },
      {
        transform: "translateX(0)",
        opacity: 0,
        offset: (holdMs + scrollMs + holdMs + fadeMs + resetMs) / duration,
      },
      { transform: "translateX(0)", opacity: 1, offset: 1 },
    ],
    {
      duration,
      easing: "linear",
      iterations: Infinity,
    }
  );
}

function closeLibrary() {
  libraryView.classList.add("is-hidden");
  launchView.classList.remove("is-hidden");
  episodes = [];
  visibleEpisodes = [];
  selectedCoverKinds = new Set();
  rowCache.clear();
  listItems.innerHTML = "";
  coverFilters.innerHTML = "";
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}

episodeList.addEventListener("scroll", renderVisibleRows, { passive: true });
window.addEventListener("resize", () => {
  renderVisibleRows();
  updateHeroTitleMarquee();
});
backButton.addEventListener("click", closeLibrary);
searchInput.addEventListener("input", debounce(async (event) => {
  query = event.target.value.trim();
  await loadEpisodes();
}, 160));

function initGlobalTooltip() {
  const tooltip = document.getElementById("global-tooltip");
  if (!tooltip) return null;
  let activeTarget = null;

  function viewportClientBox() {
    const vv = window.visualViewport;
    if (vv) {
      return {
        left: vv.offsetLeft,
        top: vv.offsetTop,
        width: vv.width,
        height: vv.height,
      };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function clampTooltipToViewport(marginPx) {
    const m = marginPx;
    void tooltip.offsetWidth;
    let r = tooltip.getBoundingClientRect();
    let baseLeft = parseFloat(tooltip.style.left);
    let baseTop = parseFloat(tooltip.style.top);
    if (!Number.isFinite(baseLeft)) baseLeft = r.left;
    if (!Number.isFinite(baseTop)) baseTop = r.top;

    for (let pass = 0; pass < 3; pass += 1) {
      const vp = viewportClientBox();
      const minL = vp.left + m;
      const maxR = vp.left + vp.width - m;
      const minT = vp.top + m;
      const maxB = vp.top + vp.height - m;
      let dx = 0;
      let dy = 0;

      if (r.left < minL) dx = minL - r.left;
      else if (r.right > maxR) dx = maxR - r.right;
      if (r.top < minT) dy = minT - r.top;
      else if (r.bottom > maxB) dy = maxB - r.bottom;
      if (!dx && !dy) break;

      baseLeft += dx;
      baseTop += dy;
      tooltip.style.left = `${baseLeft}px`;
      tooltip.style.top = `${baseTop}px`;
      void tooltip.offsetWidth;
      r = tooltip.getBoundingClientRect();
    }
  }

  function dismissGlobalTooltip() {
    tooltip.classList.remove("visible");
    activeTarget = null;
  }

  function showTooltip(targetEl, tipText) {
    activeTarget = targetEl;
    tooltip.textContent = tipText;
    tooltip.classList.add("visible");
    void tooltip.offsetWidth;

    const rect = targetEl.getBoundingClientRect();
    const margin = 10;
    const tipW = tooltip.offsetWidth;
    const tipH = tooltip.offsetHeight;
    const vpBox = viewportClientBox();
    const vpBot = vpBox.top + vpBox.height;
    const place = (targetEl.getAttribute("data-tip-placement") || "").toLowerCase();
    let top;

    if (place === "bottom") {
      top = rect.bottom + margin;
      if (top + tipH > vpBot - margin) top = rect.top - tipH - margin;
    } else {
      top = rect.top - tipH - margin;
      if (top < vpBox.top + margin) top = rect.bottom + margin;
    }

    top = Math.max(vpBox.top + margin, Math.min(top, vpBot - tipH - margin));
    let left = rect.left + rect.width / 2 - tipW / 2;
    const leftMax = vpBox.left + vpBox.width - tipW - margin;
    left = Math.max(vpBox.left + margin, Math.min(left, leftMax));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    clampTooltipToViewport(margin);
  }

  document.addEventListener("mouseover", (event) => {
    let el = event.target;
    if (!el) return;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

    let targetEl = el.closest("[data-tip]");
    let tipText = targetEl ? targetEl.getAttribute("data-tip") : null;
    if (!targetEl) {
      const style = window.getComputedStyle(el);
      if (style.textOverflow === "ellipsis" && el.scrollWidth - el.offsetWidth > 2) {
        targetEl = el;
        tipText = el.textContent.trim();
      }
    } else {
      const style = window.getComputedStyle(targetEl);
      if (style.textOverflow === "ellipsis" && targetEl.scrollWidth - targetEl.offsetWidth <= 2) {
        targetEl = null;
        tipText = null;
      }
    }

    if (targetEl && tipText) showTooltip(targetEl, tipText);
  });

  document.addEventListener("mouseout", (event) => {
    if (activeTarget && !activeTarget.contains(event.relatedTarget)) {
      dismissGlobalTooltip();
    }
  });
  document.addEventListener("scroll", dismissGlobalTooltip, true);
  document.addEventListener("click", dismissGlobalTooltip, true);

  window.MsspAnthology = window.MsspAnthology || {};
  window.MsspAnthology.dismissGlobalTooltip = dismissGlobalTooltip;
  return dismissGlobalTooltip;
}

(async function init() {
  initGlobalTooltip();
  const data = await getJson("/api/collections");
  collections = data.collections;
  renderCollections();
})();
