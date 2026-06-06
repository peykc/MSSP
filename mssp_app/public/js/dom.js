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
};
