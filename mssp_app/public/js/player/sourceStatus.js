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
    if (hasConnectedPatreonSource(episode)) {
      return {
        id: SOURCE_STATUSES.RSS_CONNECTED,
        label: "Ready to play",
        detail: "This PAYTCH episode is connected through your private Patreon RSS feed.",
        sourceType: SOURCE_TYPES.PATREON_RSS,
      };
    }

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

function hasConnectedPatreonSource(episode) {
  return episode?.sourceType === SOURCE_TYPES.PATREON_RSS
    || episode?.source?.type === SOURCE_TYPES.PATREON_RSS
    || episode?.patreonRssConnected === true;
}
