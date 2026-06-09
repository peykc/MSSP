function getRequiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`[MSSP] Missing required DOM element: #${id}`);
  }
  return element;
}

export const dom = {
  collectionGrid: getRequiredElement("collectionGrid"),
  launchView: getRequiredElement("launchView"),
  libraryView: getRequiredElement("libraryView"),
  heroPanel: getRequiredElement("heroPanel"),
  heroCover: getRequiredElement("heroCover"),
  heroDetails: getRequiredElement("heroDetails"),
  panelTitle: getRequiredElement("panelTitle"),
  searchInput: getRequiredElement("searchInput"),
  coverFilters: getRequiredElement("coverFilters"),
  episodeList: getRequiredElement("episodeList"),
  listSpacer: getRequiredElement("listSpacer"),
  listItems: getRequiredElement("listItems"),
  backButton: getRequiredElement("backButton"),
  app: getRequiredElement("app"),
  playerBackdrop: getRequiredElement("playerBackdrop"),
  fullPlayer: getRequiredElement("fullPlayer"),
  fullPlayerCollapse: getRequiredElement("fullPlayerCollapse"),
  fullPlayerCover: getRequiredElement("fullPlayerCover"),
  fullPlayerEyebrow: getRequiredElement("fullPlayerEyebrow"),
  fullPlayerTitle: getRequiredElement("fullPlayerTitle"),
  fullPlayerMeta: getRequiredElement("fullPlayerMeta"),
  fullPlayerStatus: getRequiredElement("fullPlayerStatus"),
  fullPlayerStatusDetail: getRequiredElement("fullPlayerStatusDetail"),
  playerTimeline: getRequiredElement("playerTimeline"),
  playerTimelineStart: getRequiredElement("playerTimelineStart"),
  playerTimelineEnd: getRequiredElement("playerTimelineEnd"),
  playerAutoplay: getRequiredElement("playerAutoplay"),
  playerPrevious: getRequiredElement("playerPrevious"),
  playerPlay: getRequiredElement("playerPlay"),
  playerNext: getRequiredElement("playerNext"),
  miniPlayer: getRequiredElement("miniPlayer"),
  miniPlayerExpand: getRequiredElement("miniPlayerExpand"),
  miniPlayerCover: getRequiredElement("miniPlayerCover"),
  miniPlayerTitle: getRequiredElement("miniPlayerTitle"),
  miniPlayerStatus: getRequiredElement("miniPlayerStatus"),
  miniPlayerPrevious: getRequiredElement("miniPlayerPrevious"),
  miniPlayerPlay: getRequiredElement("miniPlayerPlay"),
  miniPlayerNext: getRequiredElement("miniPlayerNext"),
};
