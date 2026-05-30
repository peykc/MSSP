const collectionGrid = document.getElementById("collectionGrid");
const launchView = document.getElementById("launchView");
const libraryView = document.getElementById("libraryView");
const heroCover = document.getElementById("heroCover");
const heroDetails = document.getElementById("heroDetails");
const panelTitle = document.getElementById("panelTitle");
const searchInput = document.getElementById("searchInput");
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
let selectedEpisodeId = null;
let query = "";

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
    button.innerHTML = `
      <img class="collection-card__cover" src="${collection.coverUrl}" alt="">
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
  selectedEpisodeId = episodes[0]?.id ?? null;
  listSpacer.style.height = `${episodes.length * ROW_HEIGHT}px`;
  episodeList.scrollTop = 0;
  renderDetails();
  renderVisibleRows();
}

function renderVisibleRows() {
  const viewportHeight = episodeList.clientHeight;
  const scrollTop = episodeList.scrollTop;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(episodes.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleKeys = new Set();

  for (let index = start; index < end; index += 1) {
    const episode = episodes[index];
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
  const episode = episodes.find((item) => item.id === selectedEpisodeId);
  if (!episode) {
    heroCover.src = activeCollection.coverUrl;
    heroCover.alt = `${activeCollection.name} cover`;
    heroDetails.innerHTML = "<span>No episodes match this view.</span>";
    return;
  }

  heroCover.src = episode.coverUrl;
  heroCover.alt = `${episode.title || "Selected episode"} cover`;
  heroDetails.innerHTML = `
    <span class="hero-details__title">${episode.title}</span>
    <span>${episode.date || "Unknown date"}</span>
    <span>${episode.type || "MSSP"}</span>
    <span>${episode.paytch ? "PAYTCH" : "Public"}</span>
    <span>${episode.episode ? `Ep. ${episode.episode}` : "Episode details WIP"}</span>
  `;
}

function closeLibrary() {
  libraryView.classList.add("is-hidden");
  launchView.classList.remove("is-hidden");
  episodes = [];
  rowCache.clear();
  listItems.innerHTML = "";
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}

episodeList.addEventListener("scroll", renderVisibleRows, { passive: true });
window.addEventListener("resize", renderVisibleRows);
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
