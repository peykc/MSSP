const PRIVATE_R2_SOURCES = Object.freeze({
  "2025-11-13 MSSP PAYTCH Ep. 585 - UFC GAMING TOURNAMENT": Object.freeze({
    sourceType: "patreon_r2_audio",
    objectKey: "paytch/2025-11-13 MSSP PAYTCH Ep. 585 - UFC GAMING TOURNAMENT.mp3",
    url: "https://mssp.pkcollection.net/paytch/2025-11-13%20MSSP%20PAYTCH%20Ep.%20585%20-%20UFC%20GAMING%20TOURNAMENT.mp3",
    mimeType: "audio/mpeg",
    credit: "Private Patreon connection with MSSP R2 audio",
  }),
});

export function addPatreonR2Sources(episodes, sources) {
  let added = 0;
  for (const episode of episodes || []) {
    if (episode?.paytch !== "PAYTCH" || sources[episode.episodeKey]) continue;
    const fallback = PRIVATE_R2_SOURCES[episode.episodeKey];
    if (!fallback) continue;
    sources[episode.episodeKey] = { ...fallback };
    added += 1;
  }
  return added;
}
