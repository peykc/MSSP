import { SOURCE_STATUSES } from "./player/sourceStatus.js";

const ROW_HEIGHT = 64;
const OVERSCAN = 8;

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

export function createEpisodeList({
  dom,
  state,
  getVisibleEpisodes,
  renderDetails,
  dismissGlobalTooltip,
  onPlayRequest,
  getSourceStatusForEpisode,
}) {
  const rowCache = new Map();

  function clearRows() {
    rowCache.clear();
    dom.listItems.innerHTML = "";
  }

  function applyEpisodeFilters({ resetSelection = false, preserveScroll = false } = {}) {
    const previousScrollTop = dom.episodeList.scrollTop;
    const anchorIndex = Math.floor(previousScrollTop / ROW_HEIGHT);
    const anchorOffset = previousScrollTop - anchorIndex * ROW_HEIGHT;
    const anchorEpisode = preserveScroll ? state.visibleEpisodes[anchorIndex] : null;

    state.visibleEpisodes = getVisibleEpisodes();
    const selectedIsVisible = state.visibleEpisodes.some((episode) => episode.id === state.selectedEpisodeId);
    if (resetSelection || !selectedIsVisible) {
      state.selectedEpisodeId = state.visibleEpisodes[0]?.id ?? null;
    }
    clearRows();
    dom.listSpacer.style.height = `${state.visibleEpisodes.length * ROW_HEIGHT}px`;

    if (!preserveScroll) return;

    const anchorNewIndex = anchorEpisode
      ? state.visibleEpisodes.findIndex((episode) => episode.id === anchorEpisode.id)
      : -1;
    const maxScrollTop = Math.max(0, state.visibleEpisodes.length * ROW_HEIGHT - dom.episodeList.clientHeight);
    const nextScrollTop = anchorNewIndex >= 0
      ? anchorNewIndex * ROW_HEIGHT + anchorOffset
      : Math.min(previousScrollTop, maxScrollTop);
    dom.episodeList.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    dismissGlobalTooltip?.();
  }

  function renderVisibleRows() {
    const viewportHeight = dom.episodeList.clientHeight;
    const scrollTop = dom.episodeList.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(state.visibleEpisodes.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleKeys = new Set();

    for (let index = start; index < end; index += 1) {
      const episode = state.visibleEpisodes[index];
      const key = episode.id;
      visibleKeys.add(key);
      const row = getMemoizedRow(episode);
      row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
      const isSelected = episode.id === state.selectedEpisodeId;
      row.classList.toggle("is-selected", isSelected);
      updateRowTitleMarquee(row, isSelected);
      if (row.parentElement !== dom.listItems) dom.listItems.append(row);
    }

    for (const child of [...dom.listItems.children]) {
      const key = Number(child.dataset.id);
      if (!visibleKeys.has(key)) child.remove();
    }
  }

  function getMemoizedRow(episode) {
    if (rowCache.has(episode.id)) {
      const row = rowCache.get(episode.id);
      updatePlayButton(row.querySelector(".episode-row__play"), episode);
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
      <button class="episode-row__select" type="button">
        <span class="episode-row__main">
          <span class="episode-row__line">
            <span class="episode-row__episode"></span>
            <span class="episode-row__title">
              <span class="episode-row__title-text"></span>
            </span>
          </span>
        </span>
        <span class="episode-row__date"></span>
      </button>
    `;
    const title = episode.title || "Untitled episode";
    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const titleEl = row.querySelector(".episode-row__title-text");
    const coverButton = row.querySelector(".episode-row__cover");
    const selectButton = row.querySelector(".episode-row__select");
    const playButton = row.querySelector(".episode-row__play");
    row.querySelector(".episode-row__episode").textContent = episodeLabel;
    titleEl.textContent = title;
    row.querySelector(".episode-row__date").textContent = episode.date || "";
    updatePlayButton(playButton, episode);
    coverButton.setAttribute("aria-label", `Select ${title}`);
    const selectEpisode = () => {
      state.selectedEpisodeId = episode.id;
      renderDetails();
      renderVisibleRows();
    };
    coverButton.addEventListener("click", selectEpisode);
    selectButton.addEventListener("click", selectEpisode);
    playButton.addEventListener("click", (event) => onPlayRequest(episode, event.currentTarget));
    rowCache.set(episode.id, row);
    return row;
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
