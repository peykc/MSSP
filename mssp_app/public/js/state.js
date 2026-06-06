export function createAppState() {
  return {
    collections: [],
    activeCollection: null,
    episodes: [],
    visibleEpisodes: [],
    selectedEpisodeId: null,
    query: "",
    selectedCoverKinds: new Set(),
  };
}
