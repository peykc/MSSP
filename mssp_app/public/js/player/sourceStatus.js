export const SOURCE_TYPES = Object.freeze({
  R2_AUDIO: "r2_audio",
  PUBLIC_RSS: "public_rss",
  PUBLIC_RSS_AUDIO: "public_rss_audio",
  YOUTUBE_EMBED: "youtube_embed",
  PATREON_RSS: "patreon_rss",
  PATREON_R2_AUDIO: "patreon_r2_audio",
  LOCAL_FILE: "local_file",
});

export const SOURCE_STATUSES = Object.freeze({
  READY: "ready",
  MISSING: "missing",
  RSS_REQUIRED: "rss_required",
  RSS_CONNECTED: "rss_connected",
});

export function getSourceStatus(episode, publicSource = null) {
  if (episode?.paytch === "PAYTCH") {
    if (
      (publicSource?.sourceType === SOURCE_TYPES.PATREON_RSS
        || publicSource?.sourceType === SOURCE_TYPES.PATREON_R2_AUDIO)
      && publicSource.url
    ) {
      return {
        id: SOURCE_STATUSES.READY,
        label: "Ready to play",
        detail: publicSource.sourceType === SOURCE_TYPES.PATREON_R2_AUDIO
          ? "This PAYTCH episode is unlocked by your private Patreon RSS connection."
          : "This PAYTCH episode is connected through your private Patreon RSS feed.",
        sourceType: publicSource.sourceType,
      };
    }

    return {
      id: SOURCE_STATUSES.RSS_REQUIRED,
      label: "Connect Patreon RSS to play",
      detail: "This PAYTCH episode needs your private Patreon RSS connection.",
      sourceType: SOURCE_TYPES.PATREON_RSS,
    };
  }

  if (isPublicAudioSource(publicSource)) {
    return {
      id: SOURCE_STATUSES.READY,
      label: "Ready to play",
      detail: publicSource.credit || "Public audio source connected.",
      sourceType: publicSource.sourceType,
    };
  }

  return {
    id: SOURCE_STATUSES.MISSING,
    label: "Source unavailable",
    detail: "Public playback sources have not been connected yet.",
    sourceType: null,
  };
}

function isPublicAudioSource(publicSource) {
  if (!publicSource?.url) return false;
  return publicSource.sourceType === SOURCE_TYPES.R2_AUDIO
    || publicSource.sourceType === SOURCE_TYPES.PUBLIC_RSS_AUDIO;
}
