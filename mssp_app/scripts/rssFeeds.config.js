module.exports = {
  // Cloudflare Worker (mssp_audio_proxy) that serves Megaphone episode audio from
  // an edge cache so every listener gets byte-identical, range-capable files.
  NT_AUDIO_PROXY_BASE: "https://nt-audio.pkcollection.net",
  PUBLIC_RSS_FEEDS: [
    {
      id: "mssp-public-current",
      label: "Official public podcast RSS",
      url: "https://feeds.megaphone.fm/GLT1158789509",
      series: "MSSP",
      isOfficial: true,
    },
  ],
};
