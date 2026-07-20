import {
  createEpisodeRow,
  createEpisodeRowMenuManager,
  refreshEpisodeRow,
  updateEpisodeRowMarquee,
  updateEpisodeRowPlayButton,
  updateEpisodeRowSignals,
} from "./episodeRow.js";

const OVERSCAN = 8;

function getRowHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--row").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 64;
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
  communitySignals,
  onFavoriteToggle,
}) {
  const rowCache = new Map();
  const menuManager = createEpisodeRowMenuManager({ scrollRoot: dom.episodeList });

  function closeEpisodeMenu() {
    menuManager.closeEpisodeMenu();
  }

  function syncEmptyState() {
    const empty = state.visibleEpisodes.length === 0;
    if (!dom.episodeListEmpty) return;
    dom.episodeListEmpty.hidden = !empty;
    dom.episodeListEmpty.textContent = state.favoritesOnly
      ? "No Favorites :("
      : "No episodes match this view.";
  }

  function clearRows() {
    closeEpisodeMenu();
    rowCache.clear();
    dom.listItems.innerHTML = "";
    communitySignals?.setTrackedEpisodeKeys("archive", []);
    syncEmptyState();
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
    syncEmptyState();
    if (menuManager.getOpenMenuRoot() && !menuManager.getOpenMenuRoot().isConnected) {
      closeEpisodeMenu();
    }
    const viewportHeight = dom.episodeList.clientHeight;
    const scrollTop = dom.episodeList.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / getRowHeight()) - OVERSCAN);
    const end = Math.min(state.visibleEpisodes.length, Math.ceil((scrollTop + viewportHeight) / getRowHeight()) + OVERSCAN);
    const visibleKeys = new Set();
    const visibleEpisodeKeys = [];

    for (let index = start; index < end; index += 1) {
      const episode = state.visibleEpisodes[index];
      const key = episode.id;
      visibleKeys.add(key);
      visibleEpisodeKeys.push(episode.episodeKey);
      const row = getMemoizedRow(episode);
      row.style.transform = `translateY(${index * getRowHeight()}px)`;
      const isSelected = episode.id === state.selectedEpisodeId;
      row.classList.toggle("is-selected", isSelected);
      refreshEpisodeRow(row, episode, {
        playbackProgressStore,
        favoritesStore,
        communitySignals,
        getSourceStatusForEpisode,
        isSelected,
        includePlay: true,
        includeSignals: true,
      });
      updateEpisodeRowMarquee(row, isSelected);
      if (row.parentElement !== dom.listItems) dom.listItems.append(row);
    }
    communitySignals?.setTrackedEpisodeKeys("archive", visibleEpisodeKeys);

    for (const child of [...dom.listItems.children]) {
      const key = Number(child.dataset.id);
      if (!visibleKeys.has(key)) {
        if (child.querySelector(".episode-row__menu.is-open")) closeEpisodeMenu();
        child.remove();
      }
    }
  }

  function getMemoizedRow(episode) {
    if (rowCache.has(episode.id)) {
      const row = rowCache.get(episode.id);
      updateEpisodeRowPlayButton(row.querySelector(".episode-row__play"), episode, getSourceStatusForEpisode);
      return row;
    }

    const row = createEpisodeRow(episode, {
      includePlay: true,
      playbackProgressStore,
      favoritesStore,
      communitySignals,
      includeSignals: true,
      getSourceStatusForEpisode,
      menuManager,
      onFavoriteToggle,
      onSelect: () => {
        closeEpisodeMenu();
        state.selectedEpisodeId = episode.id;
        renderDetails();
        renderVisibleRows();
      },
      onPlay: (targetEpisode, target) => {
        closeEpisodeMenu();
        onPlayRequest(targetEpisode, target);
      },
    });
    rowCache.set(episode.id, row);
    return row;
  }

  communitySignals?.subscribe((changedKeys) => {
    for (const row of dom.listItems.children) {
      const episodeKey = row.dataset.episodeKey;
      if (changedKeys.size && !changedKeys.has(episodeKey)) continue;
      const episode = state.visibleEpisodes.find((item) => item.episodeKey === episodeKey);
      if (episode) updateEpisodeRowSignals(row, episode, communitySignals);
    }
  });

  return {
    applyEpisodeFilters,
    clearRows,
    closeEpisodeMenu,
    renderVisibleRows,
  };
}
