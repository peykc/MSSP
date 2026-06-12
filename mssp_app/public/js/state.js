export function createAppState() {
  return {
    collections: [],
    archiveEpisodes: [],
    activeCollection: null,
    favoritesOnly: false,
    episodes: [],
    visibleEpisodes: [],
    selectedEpisodeId: null,
    query: "",
    selectedCoverKinds: new Set(),
  };
}
