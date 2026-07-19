import { SOURCE_STATUSES } from "./player/sourceStatus.js";
import { formatEpisodeLabel, formatTimeRemaining } from "./utils.js";
import { formatCommunityCount, formatListeningSignal } from "./community/communitySignals.js";

export const COMPLETED_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6 9 17l-5-5"></path>
  </svg>
`;

export const MENU_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.6"></circle>
    <circle cx="12" cy="12" r="1.6"></circle>
    <circle cx="19" cy="12" r="1.6"></circle>
  </svg>
`;

export const FAVORITE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m12 3.5 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.02l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86L12 3.5Z"></path>
  </svg>
`;

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

const MARK_LISTENED_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M12 19.5C16.1421 19.5 19.5 16.1421 19.5 12C19.5 7.85786 16.1421 4.5 12 4.5C7.85786 4.5 4.5 7.85786 4.5 12C4.5 16.1421 7.85786 19.5 12 19.5ZM12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" fill="currentColor"/>
  </svg>
`;

const UNMARK_LISTENED_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M12 19.5C16.1421 19.5 19.5 16.1421 19.5 12C19.5 7.85786 16.1421 4.5 12 4.5C7.85786 4.5 4.5 7.85786 4.5 12C4.5 16.1421 7.85786 19.5 12 19.5ZM12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" fill="currentColor"/>
    <circle cx="12" cy="12" r="5.25" fill="currentColor"/>
  </svg>
`;

const SHARE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="8 6 12 2 16 6"></polyline>
    <line x1="12" y1="2" x2="12" y2="15"></line>
    <path d="M16 10h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h2"></path>
  </svg>
`;

export const EPISODE_SHARE_PARAM = "episode";

function buildShareText(episode) {
  const label = formatEpisodeLabel(episode);
  const title = episode.title || "Untitled episode";
  return `${label} — ${title}`;
}

export function buildEpisodeShareUrl(episode) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (episode?.episodeKey) {
    url.searchParams.set(EPISODE_SHARE_PARAM, episode.episodeKey);
  }
  return url.toString();
}

export function getEpisodeRowHTML({ includePlay = true, includeSignals = false } = {}) {
  const playButton = includePlay
    ? `<button class="episode-row__play" type="button"></button>`
    : "";
  const signals = includeSignals
    ? `<span class="episode-row__signals" aria-label="Community activity">
        <span class="episode-row__signal episode-row__signal--stars" data-signal="stars">★ —</span>
        <span class="episode-row__signal episode-row__signal--listeners" data-signal="listeners" hidden></span>
      </span>`
    : "";

  return `
    <button class="episode-row__cover" type="button">
      <img src="" alt="">
    </button>
    ${playButton}
    <div class="episode-row__body">
      <button class="episode-row__select" type="button">
        <span class="episode-row__main">
          <span class="episode-row__line">
            <span class="episode-row__meta">
              <span class="episode-row__episode"></span>
              <span class="episode-row__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden>
                <span class="episode-row__progress-fill"></span>
              </span>
              <span class="episode-row__time-left" hidden></span>
              <span class="episode-row__completed" hidden aria-label="Completed">${COMPLETED_ICON}</span>
            </span>
            <span class="episode-row__title">
              <span class="episode-row__title-text"></span>
            </span>
          </span>
          ${signals}
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
              <span class="episode-row__menu-icon" aria-hidden="true">${MARK_LISTENED_ICON}</span>
              <span class="episode-row__menu-label">Mark as listened</span>
            </button>
            <button class="episode-row__menu-item" type="button" role="menuitem" data-action="unmark-listened" hidden>
              <span class="episode-row__menu-icon" aria-hidden="true">${UNMARK_LISTENED_ICON}</span>
              <span class="episode-row__menu-label">Unmark as listened</span>
            </button>
            <button class="episode-row__menu-item" type="button" role="menuitem" data-action="share">
              <span class="episode-row__menu-icon" aria-hidden="true">${SHARE_ICON}</span>
              <span class="episode-row__menu-label">Share episode</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function populateEpisodeRow(row, episode) {
  const title = episode.title || "Untitled episode";
  const episodeLabel = formatEpisodeLabel(episode);
  const coverImg = row.querySelector(".episode-row__cover img");
  const titleEl = row.querySelector(".episode-row__title-text");

  row.dataset.id = String(episode.id);
  row.dataset.episodeKey = episode.episodeKey;
  if (coverImg) {
    coverImg.src = episode.coverUrl;
    coverImg.alt = "";
  }
  row.querySelector(".episode-row__episode").textContent = episodeLabel;
  if (titleEl) titleEl.textContent = title;
  row.querySelector(".episode-row__date").textContent = episode.date || "";
  row.querySelector(".episode-row__cover")?.setAttribute("aria-label", `Select ${title}`);
  row.querySelector(".episode-row__date")?.setAttribute("aria-label", `Select ${title}`);
}

export function updateEpisodeRowPlayButton(playButton, episode, getSourceStatusForEpisode) {
  if (!playButton) return;
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
        : `Open player for ${title}`,
  );
}

export function updateEpisodeRowProgress(row, episode, playbackProgressStore) {
  const progressEl = row.querySelector(".episode-row__progress");
  const timeLeftEl = row.querySelector(".episode-row__time-left");
  const completedEl = row.querySelector(".episode-row__completed");
  const fillEl = row.querySelector(".episode-row__progress-fill");
  if (!progressEl || !completedEl || !fillEl) return;

  const progress = playbackProgressStore?.getEpisodeProgress(episode.episodeKey) || { status: "none" };
  row.classList.toggle("is-finished", progress.status === "completed");

  if (progress.status === "completed") {
    progressEl.hidden = true;
    if (timeLeftEl) timeLeftEl.hidden = true;
    completedEl.hidden = false;
    return;
  }

  if (progress.status === "in-progress") {
    const percent = Math.round(progress.fraction * 100);
    const timeLeftLabel = formatTimeRemaining(progress.remainingSeconds);
    progressEl.hidden = false;
    completedEl.hidden = true;
    fillEl.style.width = `${percent}%`;
    progressEl.setAttribute("aria-valuenow", String(percent));
    progressEl.setAttribute(
      "aria-label",
      timeLeftLabel ? `${percent}% listened, ${timeLeftLabel}` : `${percent}% listened`,
    );
    if (timeLeftEl) {
      timeLeftEl.hidden = !timeLeftLabel;
      timeLeftEl.textContent = timeLeftLabel;
    }
    return;
  }

  progressEl.hidden = true;
  if (timeLeftEl) timeLeftEl.hidden = true;
  completedEl.hidden = true;
  fillEl.style.width = "0%";
  progressEl.removeAttribute("aria-valuenow");
  progressEl.removeAttribute("aria-label");
}

export function updateEpisodeRowFavorite(row, episode, favoritesStore) {
  const favoriteButton = row.querySelector(".episode-row__favorite");
  if (!favoriteButton) return;
  const isFavorite = favoritesStore?.has(episode) ?? false;
  favoriteButton.setAttribute("aria-pressed", isFavorite ? "true" : "false");
  favoriteButton.setAttribute(
    "aria-label",
    isFavorite ? "Remove from favorites" : "Add to favorites",
  );
}

export function updateEpisodeRowSignals(row, episode, communitySignals) {
  const starsElement = row.querySelector('[data-signal="stars"]');
  const listenersElement = row.querySelector('[data-signal="listeners"]');
  if (!starsElement || !listenersElement) return;
  const signals = communitySignals?.getEpisodeSignals(episode.episodeKey) || {
    stars: null,
    listeners: null,
  };
  starsElement.textContent = `★ ${formatCommunityCount(signals.stars, { compact: true })}`;
  const listeningLabel = formatListeningSignal(signals.listeners, { compact: true });
  listenersElement.hidden = !listeningLabel;
  listenersElement.textContent = listeningLabel;
}

export function updateEpisodeRowMenuItems(row, episode, playbackProgressStore) {
  const menuRoot = row.querySelector(".episode-row__menu");
  if (!menuRoot) return;
  const progress = playbackProgressStore?.getEpisodeProgress(episode.episodeKey) || { status: "none" };
  const isCompleted = progress.status === "completed";
  const panel = menuRoot.querySelector(".episode-row__menu-panel")
    || (menuRoot.classList.contains("is-open")
      ? document.body.querySelector(".episode-row__menu-panel:not([hidden])")
      : null);
  if (!panel) return;
  const markButton = panel.querySelector('[data-action="mark-listened"]');
  const unmarkButton = panel.querySelector('[data-action="unmark-listened"]');
  if (markButton) markButton.hidden = isCompleted;
  if (unmarkButton) unmarkButton.hidden = !isCompleted;
}

export function refreshEpisodeRow(row, episode, {
  playbackProgressStore,
  favoritesStore,
  communitySignals,
  getSourceStatusForEpisode,
  isSelected = false,
  includePlay = true,
  includeSignals = false,
} = {}) {
  populateEpisodeRow(row, episode);
  if (includePlay) {
    updateEpisodeRowPlayButton(row.querySelector(".episode-row__play"), episode, getSourceStatusForEpisode);
  }
  updateEpisodeRowProgress(row, episode, playbackProgressStore);
  updateEpisodeRowFavorite(row, episode, favoritesStore);
  if (includeSignals) updateEpisodeRowSignals(row, episode, communitySignals);
  updateEpisodeRowMenuItems(row, episode, playbackProgressStore);
  row.classList.toggle("is-selected", isSelected);
  updateEpisodeRowMarquee(row, isSelected);
}

export function updateEpisodeRowMarquee(row, isSelected) {
  const title = row.querySelector(".episode-row__title");
  const titleText = row.querySelector(".episode-row__title-text");
  if (!title || !titleText) return;

  const shouldMarquee = isSelected || row.dataset.marquee === "always";

  if (!shouldMarquee) {
    stopEpisodeRowMarquee(title, titleText);
    return;
  }

  requestAnimationFrame(() => {
    if (row.dataset.marquee !== "always" && !row.classList.contains("is-selected")) return;
    const distance = titleText.scrollWidth - title.clientWidth;
    const marqueeKey = `${title.clientWidth}:${titleText.scrollWidth}`;
    if (distance <= 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopEpisodeRowMarquee(title, titleText);
      return;
    }
    if (title.dataset.marqueeKey === marqueeKey && titleText.getAnimations().length) return;

    stopEpisodeRowMarquee(title, titleText);
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
      { duration, easing: "linear", iterations: Infinity },
    );
  });
}

export function stopEpisodeRowMarquee(title, titleText) {
  titleText.getAnimations().forEach((animation) => animation.cancel());
  titleText.style.transform = "";
  titleText.style.opacity = "";
  delete title.dataset.marqueeKey;
}

export function createEpisodeRowMenuManager({ scrollRoot } = {}) {
  let openMenu = null;
  let menuIgnoreOutsideUntil = 0;

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
    scrollRoot?.removeEventListener("scroll", listeners.scroll);
    window.removeEventListener("resize", listeners.scroll);
    openMenu = null;
    menuIgnoreOutsideUntil = 0;
  }

  function openEpisodeMenu(menuRoot, episode, toggleButton, panel, row, onRefresh) {
    closeEpisodeMenu();
    onRefresh?.(row, episode);
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
      scrollRoot?.addEventListener("scroll", listeners.scroll, { passive: true });
      window.addEventListener("resize", listeners.scroll, { passive: true });
    }, 0);
  }

  function isMenuOpen(menuRoot) {
    return openMenu?.root === menuRoot;
  }

  function getOpenMenuRoot() {
    return openMenu?.root ?? null;
  }

  return { closeEpisodeMenu, openEpisodeMenu, isMenuOpen, getOpenMenuRoot };
}

export async function shareEpisode(episode) {
  const text = buildShareText(episode);
  const url = buildEpisodeShareUrl(episode);
  const shareData = {
    title: text,
    text,
    url,
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
      await navigator.clipboard.writeText(`${text}\n${url}`);
    } catch (error) {
      console.warn("[MSSP] Could not copy episode share text.", error);
    }
  }
}

export function bindEpisodeRow(row, episode, {
  includePlay = true,
  marqueeAlways = false,
  playbackProgressStore,
  favoritesStore,
  onFavoriteToggle,
  getSourceStatusForEpisode,
  menuManager,
  onSelect,
  onActivate,
  onPlay,
  onMarkListened,
  onProgressChange,
} = {}) {
  const coverButton = row.querySelector(".episode-row__cover");
  const selectButton = row.querySelector(".episode-row__select");
  const playButton = row.querySelector(".episode-row__play");
  const dateButton = row.querySelector(".episode-row__date");
  const favoriteButton = row.querySelector(".episode-row__favorite");
  const menuRoot = row.querySelector(".episode-row__menu");
  const toggleButton = row.querySelector(".episode-row__menu-toggle");
  const panel = row.querySelector(".episode-row__menu-panel");

  const activate = (event) => {
    menuManager?.closeEpisodeMenu();
    if (onActivate) {
      onActivate(episode, event);
      return;
    }
    onSelect?.(episode, event);
  };

  coverButton?.addEventListener("click", activate);
  selectButton?.addEventListener("click", activate);
  dateButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    activate(event);
  });

  favoriteButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    menuManager?.closeEpisodeMenu();
    if (onFavoriteToggle) onFavoriteToggle(episode);
    else favoritesStore?.toggle(episode);
    updateEpisodeRowFavorite(row, episode, favoritesStore);
  });

  playButton?.addEventListener("click", (event) => {
    menuManager?.closeEpisodeMenu();
    onPlay?.(episode, event.currentTarget);
  });

  toggleButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menuManager?.isMenuOpen(menuRoot)) {
      menuManager.closeEpisodeMenu();
      return;
    }
    menuManager?.openEpisodeMenu(menuRoot, episode, toggleButton, panel, row, (targetRow, targetEpisode) => {
      updateEpisodeRowMenuItems(targetRow, targetEpisode, playbackProgressStore);
    });
  });

  panel?.addEventListener("click", (event) => event.stopPropagation());

  panel?.querySelector('[data-action="mark-listened"]')?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (onMarkListened) {
      onMarkListened(episode, row);
      return;
    }
    playbackProgressStore?.markCompleted(episode.episodeKey);
    updateEpisodeRowProgress(row, episode, playbackProgressStore);
    updateEpisodeRowMenuItems(row, episode, playbackProgressStore);
    menuManager?.closeEpisodeMenu();
    onProgressChange?.();
  });

  panel?.querySelector('[data-action="unmark-listened"]')?.addEventListener("click", (event) => {
    event.stopPropagation();
    playbackProgressStore?.removePosition(episode.episodeKey);
    updateEpisodeRowProgress(row, episode, playbackProgressStore);
    updateEpisodeRowMenuItems(row, episode, playbackProgressStore);
    menuManager?.closeEpisodeMenu();
    onProgressChange?.();
  });

  panel?.querySelector('[data-action="share"]')?.addEventListener("click", async (event) => {
    event.stopPropagation();
    menuManager?.closeEpisodeMenu();
    await shareEpisode(episode);
  });

  if (!includePlay) {
    row.classList.add("episode-row--no-play");
  }
  if (marqueeAlways) {
    row.dataset.marquee = "always";
  }
}

export function createEpisodeRow(episode, options = {}) {
  const { includePlay = true, includeSignals = false } = options;
  const row = document.createElement("div");
  row.className = "episode-row";
  row.innerHTML = getEpisodeRowHTML({ includePlay, includeSignals });
  bindEpisodeRow(row, episode, options);
  refreshEpisodeRow(row, episode, options);
  return row;
}
