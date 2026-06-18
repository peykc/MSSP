import { formatEpisodeDuration, formatEpisodeLabel, formatPlayerDate } from "./utils.js";

const STAR_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m12 3.5 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.02l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86L12 3.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
  </svg>
`;

const LISTENERS_ICON = `
  <svg aria-hidden="true" viewBox="0 0 128 128" fill="currentColor">
    <path d="M39.6,108.1c-8.8,0-16-7.2-16-16c0-2.2,1.8-4,4-4s4,1.8,4,4c0,4.4,3.6,8,8,8c2.8,0,5.4-1.5,6.9-3.9c0.6-1,1.4-2.8,2.3-4.7c1.7-3.8,3.6-8.1,6-11.2c1.9-2.5,4.7-5,7.4-7.5c2.7-2.5,5.8-5.4,6.8-7.2c2-3.5,3-7.4,3-11.4c0-12.7-10.3-23-23-23s-23,10.3-23,23c0,2.2-1.8,4-4,4s-4-1.8-4-4c0-17.1,13.9-31,31-31c17.1,0,31,13.9,31,31c0,5.4-1.4,10.7-4.1,15.4c-1.6,2.9-4.9,5.9-8.4,9.1c-2.4,2.3-5,4.6-6.5,6.5c-1.8,2.3-3.6,6.3-5,9.5c-1,2.2-1.8,4.1-2.7,5.6C50.5,105.1,45.2,108.1,39.6,108.1z"></path>
    <path d="M34,79.6c-2.2,0-4-1.8-4-4s1.8-4,4-4c2,0,3.7-1.6,3.7-3.7c0-2-1.6-3.7-3.7-3.7c-2.2,0-4-1.8-4-4v-6c0-10.5,8.5-19,19-19s19,8.5,19,19c0,3.3-0.8,6.5-2.4,9.3c-0.1,0.1-0.1,0.2-0.2,0.3c-0.8,1.2-2.7,3-5.9,6l-1.2,1.1c-1.6,1.5-4.2,1.4-5.7-0.2c-1.5-1.6-1.4-4.2,0.2-5.7L54,64c2.6-2.4,4.2-3.9,4.7-4.6c0.8-1.6,1.3-3.4,1.3-5.2c0-6.1-4.9-11-11-11s-11,4.9-11,11v2.7c4.5,1.6,7.7,5.9,7.7,11C45.7,74.3,40.5,79.6,34,79.6z"></path>
    <path d="M85,78.7c-0.6,0-1.2-0.2-1.7-0.5c-1.7-1-2.2-3.1-1.3-4.8c3.3-5.8,5.1-12.3,5.1-19c0-6.8-1.8-13.4-5.2-19.2c-1-1.7-0.4-3.8,1.2-4.8c1.7-1,3.8-0.4,4.8,1.2c4.1,6.9,6.2,14.8,6.2,22.8c0,7.9-2.1,15.6-6,22.5C87.4,78.1,86.2,78.7,85,78.7z"></path>
    <path d="M95.9,90.1c-0.8,0-1.5-0.2-2.2-0.7c-1.8-1.2-2.3-3.7-1.1-5.6c5.9-8.7,9-18.8,9-29.4c0-10.6-3.2-20.9-9.2-29.6c-1.2-1.8-0.8-4.3,1-5.6c1.8-1.2,4.3-0.8,5.6,1c6.9,10.1,10.6,21.9,10.6,34.1c0,12.1-3.6,23.8-10.3,33.8C98.4,89.5,97.1,90.1,95.9,90.1z"></path>
  </svg>
`;

const DURATION_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 7v5l3 2"></path>
  </svg>
`;

function getPlaceholderGlobalStats(episode) {
  const seed = Number(episode?.id) || 0;
  return {
    starCount: 240 + (seed * 53) % 3200,
    listenerCount: 2 + (seed * 17) % 67,
  };
}

export function createEpisodeDetails({ dom, state }) {
  function renderDetails() {
    const episode = state.visibleEpisodes.find((item) => item.id === state.selectedEpisodeId);
    if (!episode) {
      dom.heroCover.src = state.activeCollection.coverUrl;
      dom.heroCover.alt = `${state.activeCollection.name} cover`;
      dom.heroDetails.innerHTML = "<span>No episodes match this view.</span>";
      return;
    }

    dom.heroCover.src = episode.coverUrl;
    dom.heroCover.alt = `${episode.title || "Selected episode"} cover`;
    const episodeLabel = formatEpisodeLabel(episode);
    const accessLabel = episode.paytch ? "PAYTCH" : "Public";
    const { starCount, listenerCount } = getPlaceholderGlobalStats(episode);
    const durationLabel = formatEpisodeDuration(episode.durationSeconds);

    dom.heroDetails.innerHTML = `
      <div class="hero-details__copy full-player__copy">
        <p class="full-player__eyebrow">${formatPlayerDate(episode.date)}</p>
        <h2 class="full-player__title">
          <span class="full-player__episode">${episodeLabel}</span>
          <span class="full-player__title-viewport">
            <span class="full-player__title-text">${episode.title || "Untitled episode"}</span>
          </span>
        </h2>
        <p class="full-player__meta">${episode.type || "MSSP"} · ${accessLabel}</p>
      </div>
      <div class="hero-details__divider" aria-hidden="true"></div>
      <div class="hero-details__stats" data-placeholder-stats="true" aria-label="Community stats preview">
        <div class="hero-details__stat hero-details__stat--duration" aria-label="Episode length ${durationLabel}">
          <span class="hero-details__stat-icon">${DURATION_ICON}</span>
          <span class="hero-details__stat-value">${durationLabel}</span>
        </div>
        <div class="hero-details__stat" aria-label="${starCount.toLocaleString()} total stars">
          <span class="hero-details__stat-icon">${STAR_ICON}</span>
          <span class="hero-details__stat-value">${starCount.toLocaleString()}</span>
        </div>
        <div class="hero-details__stat hero-details__stat--listeners" aria-label="${listenerCount.toLocaleString()} listening now">
          <span class="hero-details__stat-icon">${LISTENERS_ICON}</span>
          <span class="hero-details__stat-value">${listenerCount.toLocaleString()}</span>
        </div>
      </div>
    `;
    requestAnimationFrame(updateHeroCoverSize);
    requestAnimationFrame(updateHeroTitleMarquee);
  }

  function updateHeroCoverSize() {
    if (!dom.heroPanel || !dom.heroCover) return;

    if (window.matchMedia("(max-aspect-ratio: 7 / 6)").matches) {
      dom.heroPanel.style.removeProperty("--hero-cover-size");
      return;
    }

    const panelStyle = window.getComputedStyle(dom.heroPanel);
    const panelWidth = dom.heroPanel.clientWidth
      - parseFloat(panelStyle.paddingLeft)
      - parseFloat(panelStyle.paddingRight);
    const panelHeight = dom.heroPanel.clientHeight
      - parseFloat(panelStyle.paddingTop)
      - parseFloat(panelStyle.paddingBottom);
    const detailsStyle = window.getComputedStyle(dom.heroDetails);
    const detailsHeight = dom.heroDetails.offsetHeight
      + parseFloat(detailsStyle.marginTop)
      + parseFloat(detailsStyle.marginBottom);
    const rowGap = parseFloat(panelStyle.rowGap) || 0;
    const availableHeight = panelHeight - dom.backButton.offsetHeight - detailsHeight - rowGap * 2;
    const size = Math.max(72, Math.min(430, panelWidth, availableHeight));
    dom.heroPanel.style.setProperty("--hero-cover-size", `${size}px`);
  }

  function updateHeroTitleMarquee() {
    const title = dom.heroDetails.querySelector(".full-player__title");
    const viewport = title?.querySelector(".full-player__title-viewport");
    const titleText = title?.querySelector(".full-player__title-text");
    if (!title || !viewport || !titleText) return;

    titleText.getAnimations().forEach((animation) => animation.cancel());
    titleText.style.transform = "";
    titleText.style.opacity = "";

    const distance = titleText.scrollWidth - viewport.clientWidth;
    if (distance <= 2) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const holdMs = 1000;
    const fadeMs = 280;
    const resetMs = 120;
    const speedPxPerSecond = 42;
    const scrollMs = Math.max(4200, Math.min(18000, (distance / speedPxPerSecond) * 1000));
    const duration = holdMs + scrollMs + holdMs + fadeMs + resetMs + fadeMs;

    titleText.animate(
      [
        { transform: "translateX(0)", opacity: 1, offset: 0 },
        { transform: "translateX(0)", opacity: 1, offset: holdMs / duration },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 1,
          offset: (holdMs + scrollMs) / duration,
        },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 1,
          offset: (holdMs + scrollMs + holdMs) / duration,
        },
        {
          transform: `translateX(${-distance}px)`,
          opacity: 0,
          offset: (holdMs + scrollMs + holdMs + fadeMs) / duration,
        },
        {
          transform: "translateX(0)",
          opacity: 0,
          offset: (holdMs + scrollMs + holdMs + fadeMs + resetMs) / duration,
        },
        { transform: "translateX(0)", opacity: 1, offset: 1 },
      ],
      {
        duration,
        easing: "linear",
        iterations: Infinity,
      }
    );
  }

  return {
    renderDetails,
    updateHeroCoverSize,
    updateHeroTitleMarquee,
  };
}
