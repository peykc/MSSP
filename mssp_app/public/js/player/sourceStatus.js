export const SOURCE_TYPES = Object.freeze({
  PUBLIC_RSS: "public_rss",
  YOUTUBE_EMBED: "youtube_embed",
  PATREON_RSS: "patreon_rss",
  LOCAL_FILE: "local_file",
});

export const SOURCE_STATUSES = Object.freeze({
  MISSING: "missing",
  PUBLIC_AVAILABLE: "public_available",
  RSS_REQUIRED: "rss_required",
  RSS_CONNECTED: "rss_connected",
});

export function getSourceStatus(episode) {
  if (episode?.paytch === "PAYTCH") {
    return {
      id: SOURCE_STATUSES.RSS_REQUIRED,
      label: "Connect Patreon RSS to play",
      detail: "This PAYTCH episode needs your private Patreon RSS connection.",
      sourceType: SOURCE_TYPES.PATREON_RSS,
    };
  }

  return {
    id: SOURCE_STATUSES.MISSING,
    label: "Source unavailable",
    detail: "Public playback sources have not been connected yet.",
    sourceType: null,
  };
}
