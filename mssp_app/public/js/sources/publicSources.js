let sources = {};
let loadPromise = null;

export function loadPublicSources() {
  loadPromise ||= fetch("./data/sources.public.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      if (payload?.schemaVersion !== 1 || !payload.sources || typeof payload.sources !== "object") {
        throw new Error("Invalid public source map");
      }
      sources = payload.sources;
      return sources;
    })
    .catch((error) => {
      sources = {};
      console.warn("[MSSP] Public source map unavailable; public playback is disabled.", error);
      return sources;
    });

  return loadPromise;
}

export function getPublicSourceForEpisode(episode) {
  return episode?.episodeKey ? sources[episode.episodeKey] || null : null;
}

export function hasPublicSource(episode) {
  return Boolean(getPublicSourceForEpisode(episode));
}
