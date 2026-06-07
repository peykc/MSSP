const ROW_HEIGHT = 64;
const OVERSCAN = 8;

export function createEpisodeList({
  dom,
  state,
  getVisibleEpisodes,
  renderDetails,
  dismissGlobalTooltip,
  onPlayRequest,
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
      row.classList.toggle("is-selected", episode.id === state.selectedEpisodeId);
      if (row.parentElement !== dom.listItems) dom.listItems.append(row);
    }

    for (const child of [...dom.listItems.children]) {
      const key = Number(child.dataset.id);
      if (!visibleKeys.has(key)) child.remove();
    }
  }

  function getMemoizedRow(episode) {
    if (rowCache.has(episode.id)) return rowCache.get(episode.id);

    const row = document.createElement("div");
    row.className = "episode-row";
    row.dataset.id = episode.id;
    row.innerHTML = `
      <button class="episode-row__select" type="button">
        <img src="${episode.coverUrl}" alt="">
        <span class="episode-row__main">
          <span class="episode-row__line">
            <span class="episode-row__episode"></span>
            <span class="episode-row__title"></span>
          </span>
        </span>
        <span class="episode-row__date"></span>
      </button>
      <button class="episode-row__play" type="button"></button>
    `;
    const title = episode.title || "Untitled episode";
    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const titleEl = row.querySelector(".episode-row__title");
    const selectButton = row.querySelector(".episode-row__select");
    const playButton = row.querySelector(".episode-row__play");
    row.querySelector(".episode-row__episode").textContent = episodeLabel;
    titleEl.textContent = title;
    row.querySelector(".episode-row__date").textContent = episode.date || "";
    playButton.textContent = episode.paytch === "PAYTCH" ? "RSS" : "▶";
    playButton.setAttribute(
      "aria-label",
      episode.paytch === "PAYTCH"
        ? `Connect Patreon RSS for ${title}`
        : `Open player for ${title}`
    );
    selectButton.addEventListener("click", () => {
      state.selectedEpisodeId = episode.id;
      renderDetails();
      renderVisibleRows();
    });
    playButton.addEventListener("click", (event) => onPlayRequest(episode, event.currentTarget));
    rowCache.set(episode.id, row);
    return row;
  }

  return {
    applyEpisodeFilters,
    clearRows,
    renderVisibleRows,
  };
}
