import { SOURCE_STATUSES } from "./player/sourceStatus.js";
import { formatEpisodeLabel } from "./utils.js";

const OVERSCAN = 8;

function getRowHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 64;
}

const LOCK_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M7 9V7a5 5 0 0 1 10 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v2Zm3 4a2 2 0 0 1 1.18 3.62L14 20h-4l.82-3.38A2 2 0 0 1 12 13Z"></path>
  </svg>
`;

const PLAY_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m7 4 12 8-12 8V4Z"></path>
  </svg>
`;

const COMPLETED_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6 9 17l-5-5"></path>
  </svg>
`;

const MENU_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.6"></circle>
    <circle cx="12" cy="12" r="1.6"></circle>
    <circle cx="19" cy="12" r="1.6"></circle>
  </svg>
`;

const FAVORITE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m12 3.5 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.02l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86L12 3.5Z"></path>
  </svg>
`;

function buildShareText(episode) {
  const label = formatEpisodeLabel(episode);
  const title = episode.title || "Untitled episode";
  return `${label} — ${title}`;
}

export function createEpisodeList({
  dom,
  state,
  getVisibleEpisodes,
  renderDetails,
  dismissGlobalTooltip,
  onPlayRequest,
  getSourceStatusForEpisode,
  playbackProgressStore,
  favoritesStore,
}) {
  const rowCache = new Map();
  let openMenu = null;
  let menuIgnoreOutsideUntil = 0;

  function clearRows() {
    closeEpisodeMenu();
    rowCache.clear();
    dom.listItems.innerHTML = "";
  }

  function applyEpisodeFilters({ resetSelection = false, preserveScroll = false } = {}) {
    const previousScrollTop = dom.episodeList.scrollTop;
    const anchorIndex = Math.floor(previousScrollTop / getRowHeight());
    const anchorOffset = previousScrollTop - anchorIndex * getRowHeight();
    const anchorEpisode = preserveScroll ? state.visibleEpisodes[anchorIndex] : null;

    state.visibleEpisodes = getVisibleEpisodes();
    const selectedIsVisible = state.visibleEpisodes.some((episode) => episode.id === state.selectedEpisodeId);
    if (resetSelection || !selectedIsVisible) {
      state.selectedEpisodeId = state.visibleEpisodes[0]?.id ?? null;
    }
    clearRows();
    dom.listSpacer.style.height = `${state.visibleEpisodes.length * getRowHeight()}px`;

    if (!preserveScroll) return;

    const anchorNewIndex = anchorEpisode
      ? state.visibleEpisodes.findIndex((episode) => episode.id === anchorEpisode.id)
      : -1;
    const maxScrollTop = Math.max(0, state.visibleEpisodes.length * getRowHeight() - dom.episodeList.clientHeight);
    const nextScrollTop = anchorNewIndex >= 0
      ? anchorNewIndex * getRowHeight() + anchorOffset
      : Math.min(previousScrollTop, maxScrollTop);
    dom.episodeList.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    dismissGlobalTooltip?.();
    closeEpisodeMenu();
  }

  function renderVisibleRows() {
    if (openMenu?.root && !openMenu.root.isConnected) closeEpisodeMenu();
    const viewportHeight = dom.episodeList.clientHeight;
    const scrollTop = dom.episodeList.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / getRowHeight()) - OVERSCAN);
    const end = Math.min(state.visibleEpisodes.length, Math.ceil((scrollTop + viewportHeight) / getRowHeight()) + OVERSCAN);
    const visibleKeys = new Set();

    for (let index = start; index < end; index += 1) {
      const episode = state.visibleEpisodes[index];
      const key = episode.id;
      visibleKeys.add(key);
      const row = getMemoizedRow(episode);
      row.style.transform = `translateY(${index * getRowHeight()}px)`;
      const isSelected = episode.id === state.selectedEpisodeId;
      row.classList.toggle("is-selected", isSelected);
      updateRowProgress(row, episode);
      updateRowFavorite(row, episode);
      updateRowTitleMarquee(row, isSelected);
      if (row.parentElement !== dom.listItems) dom.listItems.append(row);
    }

    for (const child of [...dom.listItems.children]) {
      const key = Number(child.dataset.id);
      if (!visibleKeys.has(key)) {
        if (openMenu?.root && child.contains(openMenu.root)) closeEpisodeMenu();
        child.remove();
      }
    }
  }

  function getMemoizedRow(episode) {
    if (rowCache.has(episode.id)) {
      const row = rowCache.get(episode.id);
      updatePlayButton(row.querySelector(".episode-row__play"), episode);
      updateRowProgress(row, episode);
      updateRowFavorite(row, episode);
      updateMenuItems(row, episode);
      return row;
    }

    const row = document.createElement("div");
    row.className = "episode-row";
    row.dataset.id = episode.id;
    row.innerHTML = `
      <button class="episode-row__cover" type="button">
        <img src="${episode.coverUrl}" alt="">
      </button>
      <button class="episode-row__play" type="button"></button>
      <div class="episode-row__body">
        <button class="episode-row__select" type="button">
          <span class="episode-row__main">
            <span class="episode-row__line">
              <span class="episode-row__meta">
                <span class="episode-row__episode"></span>
                <span class="episode-row__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden>
                  <span class="episode-row__progress-fill"></span>
                </span>
                <span class="episode-row__completed" hidden aria-label="Completed">${COMPLETED_ICON}</span>
              </span>
              <span class="episode-row__title">
                <span class="episode-row__title-text"></span>
              </span>
            </span>
          </span>
        </button>
      </div>
      <div class="episode-row__aside">
        <button class="episode-row__date" type="button"></button>
        <div class="episode-row__actions">
          <button
            class="episode-row__favorite"
            type="button"
            aria-pressed="false"
            aria-label="Add to favorites"
          >${FAVORITE_ICON}</button>
          <div class="episode-row__menu">
            <button
              class="episode-row__menu-toggle"
              type="button"
              aria-expanded="false"
              aria-haspopup="menu"
              aria-label="Episode options"
            >${MENU_ICON}</button>
            <div class="episode-row__menu-panel" role="menu" hidden>
              <button class="episode-row__menu-item" type="button" role="menuitem" data-action="mark-listened" hidden>
                Mark as listened
              </button>
              <button class="episode-row__menu-item" type="button" role="menuitem" data-action="unmark-listened" hidden>
                Unmark as listened
              </button>
              <button class="episode-row__menu-item" type="button" role="menuitem" data-action="share">
                Share episode
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    const title = episode.title || "Untitled episode";
    const episodeLabel = formatEpisodeLabel(episode);
    const titleEl = row.querySelector(".episode-row__title-text");
    const coverButton = row.querySelector(".episode-row__cover");
    const selectButton = row.querySelector(".episode-row__select");
    const playButton = row.querySelector(".episode-row__play");
    const dateButton = row.querySelector(".episode-row__date");
    const favoriteButton = row.querySelector(".episode-row__favorite");
    row.querySelector(".episode-row__episode").textContent = episodeLabel;
    titleEl.textContent = title;
    dateButton.textContent = episode.date || "";
    updatePlayButton(playButton, episode);
    updateRowProgress(row, episode);
    updateRowFavorite(row, episode);
    updateMenuItems(row, episode);
    coverButton.setAttribute("aria-label", `Select ${title}`);
    dateButton.setAttribute("aria-label", `Select ${title}`);
    const selectEpisode = () => {
      closeEpisodeMenu();
      state.selectedEpisodeId = episode.id;
      renderDetails();
      renderVisibleRows();
    };
    coverButton.addEventListener("click", selectEpisode);
    selectButton.addEventListener("click", selectEpisode);
    dateButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectEpisode();
    });
    bindEpisodeMenu(row, episode);
    favoriteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEpisodeMenu();
      favoritesStore?.toggle(episode);
      updateRowFavorite(row, episode);
    });
    playButton.addEventListener("click", (event) => {
      closeEpisodeMenu();
      onPlayRequest(episode, event.currentTarget);
    });
    rowCache.set(episode.id, row);
    return row;
  }

  function updateRowProgress(row, episode) {
    const progressEl = row.querySelector(".episode-row__progress");
    const completedEl = row.querySelector(".episode-row__completed");
    const fillEl = row.querySelector(".episode-row__progress-fill");
    if (!progressEl || !completedEl || !fillEl) return;

    const progress = playbackProgressStore?.getEpisodeProgress(episode.episodeKey) || { status: "none" };
    row.classList.toggle("is-finished", progress.status === "completed");

    if (progress.status === "completed") {
      progressEl.hidden = true;
      completedEl.hidden = false;
      return;
    }

    if (progress.status === "in-progress") {
      const percent = Math.round(progress.fraction * 100);
      progressEl.hidden = false;
      completedEl.hidden = true;
      fillEl.style.width = `${percent}%`;
      progressEl.setAttribute("aria-valuenow", String(percent));
      progressEl.setAttribute("aria-label", `${percent}% listened`);
      return;
    }

    progressEl.hidden = true;
    completedEl.hidden = true;
    fillEl.style.width = "0%";
    progressEl.removeAttribute("aria-valuenow");
    progressEl.removeAttribute("aria-label");
  }

  function updateRowFavorite(row, episode) {
    const favoriteButton = row.querySelector(".episode-row__favorite");
    if (!favoriteButton) return;
    const isFavorite = favoritesStore?.has(episode) ?? false;
    favoriteButton.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    favoriteButton.setAttribute(
      "aria-label",
      isFavorite ? "Remove from favorites" : "Add to favorites",
    );
  }

  function updateMenuItems(row, episode) {
    const menuRoot = row.querySelector(".episode-row__menu");
    if (!menuRoot) return;
    const progress = playbackProgressStore?.getEpisodeProgress(episode.episodeKey) || { status: "none" };
    const isCompleted = progress.status === "completed";
    menuRoot.querySelector('[data-action="mark-listened"]').hidden = isCompleted;
    menuRoot.querySelector('[data-action="unmark-listened"]').hidden = !isCompleted;
  }

  function bindEpisodeMenu(row, episode) {
    const menuRoot = row.querySelector(".episode-row__menu");
    const toggleButton = row.querySelector(".episode-row__menu-toggle");
    const panel = row.querySelector(".episode-row__menu-panel");
    if (!menuRoot || !toggleButton || !panel) return;

    toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenu?.root === menuRoot) {
        closeEpisodeMenu();
        return;
      }
      openEpisodeMenu(menuRoot, episode, toggleButton, panel, row);
    });

    panel.addEventListener("click", (event) => event.stopPropagation());

    panel.querySelector('[data-action="mark-listened"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      playbackProgressStore?.markCompleted(episode.episodeKey);
      closeEpisodeMenu();
      updateRowProgress(row, episode);
      updateMenuItems(row, episode);
    });

    panel.querySelector('[data-action="unmark-listened"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      playbackProgressStore?.removePosition(episode.episodeKey);
      closeEpisodeMenu();
      updateRowProgress(row, episode);
      updateMenuItems(row, episode);
    });

    panel.querySelector('[data-action="share"]')?.addEventListener("click", async (event) => {
      event.stopPropagation();
      closeEpisodeMenu();
      await shareEpisode(episode);
    });
  }

  function positionMenuPanel(panel, toggleButton) {
    const rect = toggleButton.getBoundingClientRect();
    const panelWidth = 228;
    const margin = 8;
    let top = rect.bottom + 6;
    let left = rect.right - panelWidth;
    left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));

    panel.style.position = "fixed";
    panel.style.width = `${panelWidth}px`;
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.top = `${top}px`;
    panel.dataset.placement = "bottom";

    const panelHeight = panel.offsetHeight;
    if (top + panelHeight > window.innerHeight - margin) {
      top = rect.top - panelHeight - 6;
      panel.style.top = `${Math.max(margin, top)}px`;
      panel.dataset.placement = "top";
    }
  }

  function resetMenuPanelPosition(panel) {
    panel.style.position = "";
    panel.style.top = "";
    panel.style.left = "";
    panel.style.right = "";
    panel.style.width = "";
    panel.style.bottom = "";
    delete panel.dataset.placement;
  }

  function openEpisodeMenu(menuRoot, episode, toggleButton, panel, row) {
    closeEpisodeMenu();
    updateMenuItems(row, episode);
    toggleButton.setAttribute("aria-expanded", "true");
    panel.removeAttribute("hidden");
    menuRoot.classList.add("is-open");
    document.body.append(panel);
    positionMenuPanel(panel, toggleButton);
    menuIgnoreOutsideUntil = Date.now() + 320;

    const listeners = {
      outside: (event) => {
        if (Date.now() < menuIgnoreOutsideUntil) return;
        if (menuRoot.contains(event.target) || panel.contains(event.target)) return;
        closeEpisodeMenu();
      },
      escape: (event) => {
        if (event.key === "Escape") closeEpisodeMenu();
      },
      scroll: () => closeEpisodeMenu(),
    };

    openMenu = { root: menuRoot, panel, listeners };
    window.setTimeout(() => {
      if (!openMenu || openMenu.root !== menuRoot) return;
      positionMenuPanel(panel, toggleButton);
      document.addEventListener("pointerdown", listeners.outside, true);
      document.addEventListener("click", listeners.outside, true);
      document.addEventListener("keydown", listeners.escape);
      dom.episodeList.addEventListener("scroll", listeners.scroll, { passive: true });
      window.addEventListener("resize", listeners.scroll, { passive: true });
    }, 0);
  }

  function closeEpisodeMenu() {
    if (!openMenu) return;
    const { root, panel, listeners } = openMenu;
    const toggleButton = root.querySelector(".episode-row__menu-toggle");
    toggleButton?.setAttribute("aria-expanded", "false");
    panel.setAttribute("hidden", "");
    root.append(panel);
    root.classList.remove("is-open");
    resetMenuPanelPosition(panel);
    document.removeEventListener("pointerdown", listeners.outside, true);
    document.removeEventListener("click", listeners.outside, true);
    document.removeEventListener("keydown", listeners.escape);
    dom.episodeList.removeEventListener("scroll", listeners.scroll);
    window.removeEventListener("resize", listeners.scroll);
    openMenu = null;
    menuIgnoreOutsideUntil = 0;
  }

  async function shareEpisode(episode) {
    const text = buildShareText(episode);
    const shareData = {
      title: text,
      text,
      url: window.location.href,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(`${text}\n${window.location.href}`);
      } catch (error) {
        console.warn("[MSSP] Could not copy episode share text.", error);
      }
    }
  }

  function updatePlayButton(playButton, episode) {
    const title = episode.title || "Untitled episode";
    const sourceStatus = getSourceStatusForEpisode(episode);
    const isLocked = sourceStatus.id === SOURCE_STATUSES.RSS_REQUIRED;
    const isReady = sourceStatus.id === SOURCE_STATUSES.READY;
    playButton.innerHTML = isLocked ? LOCK_ICON : PLAY_ICON;
    playButton.classList.toggle("is-locked", isLocked);
    playButton.setAttribute(
      "aria-label",
      isLocked
        ? `Connect Patreon RSS for ${title}`
        : isReady
          ? `Play ${title}`
          : `Open player for ${title}`
    );
  }

  function updateRowTitleMarquee(row, isSelected) {
    const title = row.querySelector(".episode-row__title");
    const titleText = row.querySelector(".episode-row__title-text");
    if (!title || !titleText) return;

    if (!isSelected) {
      stopRowTitleMarquee(title, titleText);
      return;
    }

    requestAnimationFrame(() => {
      if (!row.classList.contains("is-selected")) return;
      const distance = titleText.scrollWidth - title.clientWidth;
      const marqueeKey = `${title.clientWidth}:${titleText.scrollWidth}`;
      if (distance <= 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        stopRowTitleMarquee(title, titleText);
        return;
      }
      if (title.dataset.marqueeKey === marqueeKey && titleText.getAnimations().length) return;

      stopRowTitleMarquee(title, titleText);
      title.dataset.marqueeKey = marqueeKey;
      const holdMs = 1000;
      const fadeMs = 280;
      const resetMs = 120;
      const speedPxPerSecond = 42;
      const scrollMs = Math.max(4200, Math.min(18000, (distance / speedPxPerSecond) * 1000));
      const duration = holdMs + scrollMs + holdMs + fadeMs + resetMs + fadeMs;
      titleText.animate(
        [
          { transform: "translateX(0)", opacity: 1, offset: 0 },
          { transform: "translateX(0)", opacity: 1, offset: holdMs / duration },
          { transform: `translateX(${-distance}px)`, opacity: 1, offset: (holdMs + scrollMs) / duration },
          { transform: `translateX(${-distance}px)`, opacity: 1, offset: (holdMs + scrollMs + holdMs) / duration },
          { transform: `translateX(${-distance}px)`, opacity: 0, offset: (holdMs + scrollMs + holdMs + fadeMs) / duration },
          { transform: "translateX(0)", opacity: 0, offset: (holdMs + scrollMs + holdMs + fadeMs + resetMs) / duration },
          { transform: "translateX(0)", opacity: 1, offset: 1 },
        ],
        { duration, easing: "linear", iterations: Infinity }
      );
    });
  }

  function stopRowTitleMarquee(title, titleText) {
    titleText.getAnimations().forEach((animation) => animation.cancel());
    titleText.style.transform = "";
    titleText.style.opacity = "";
    delete title.dataset.marqueeKey;
  }

  return {
    applyEpisodeFilters,
    clearRows,
    renderVisibleRows,
  };
}
