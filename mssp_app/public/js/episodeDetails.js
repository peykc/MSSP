import { formatEpisodeDuration, formatEpisodeLabel, formatPlayerDate } from "./utils.js";
import { formatCommunityCount } from "./community/communitySignals.js?v=poll-cut-a";

const STAR_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m12 3.5 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.02l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86L12 3.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
  </svg>
`;

const DURATION_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 7v5l3 2"></path>
  </svg>
`;

export function createEpisodeDetails({
  dom,
  state,
  favoritesStore,
  communitySignals,
  onFavoriteToggle,
}) {
  function setHeroCoverImage(src, alt) {
    dom.heroCoverFrame?.classList.remove("is-favorites-placeholder");
    if (dom.heroCoverStar) dom.heroCoverStar.hidden = true;
    dom.heroCover.hidden = false;
    dom.heroCover.src = src || "";
    dom.heroCover.alt = alt || "";
  }

  function setFavoritesPlaceholderCover() {
    dom.heroCoverFrame?.classList.add("is-favorites-placeholder");
    if (dom.heroCoverStar) dom.heroCoverStar.hidden = false;
    dom.heroCover.hidden = true;
    dom.heroCover.removeAttribute("src");
    dom.heroCover.alt = "";
  }

  function renderDetails() {
    const episode = state.visibleEpisodes.find((item) => item.id === state.selectedEpisodeId);
    if (!episode) {
      communitySignals?.setTrackedEpisodeKeys("details", []);
      if (state.favoritesOnly) {
        setFavoritesPlaceholderCover();
      } else {
        setHeroCoverImage(
          state.activeCollection?.coverUrl || "",
          `${state.activeCollection?.name || "Collection"} cover`,
        );
      }
      dom.heroDetails.hidden = true;
      dom.heroDetails.innerHTML = "";
      requestAnimationFrame(updateHeroCoverSize);
      return;
    }

    dom.heroDetails.hidden = false;
    setHeroCoverImage(episode.coverUrl, `${episode.title || "Selected episode"} cover`);
    const episodeLabel = formatEpisodeLabel(episode);
    const accessLabel = episode.paytch ? "PAYTCH" : "Public";
    const durationLabel = formatEpisodeDuration(episode.durationSeconds);
    const isFavorite = favoritesStore?.has(episode) ?? false;
    communitySignals?.setTrackedEpisodeKeys("details", [episode.episodeKey]);

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
      <div class="hero-details__stats" aria-label="Episode and community activity">
        <div class="hero-details__stat hero-details__stat--duration" aria-label="Episode length ${durationLabel}">
          <span class="hero-details__stat-icon">${DURATION_ICON}</span>
          <span class="hero-details__stat-value">${durationLabel}</span>
        </div>
        <button
          class="hero-details__stat hero-details__stat--favorite"
          type="button"
          data-community-signal="stars"
          aria-pressed="${String(isFavorite)}"
          aria-label="${isFavorite ? "Remove from favorites" : "Add to favorites"}"
        >
          <span class="hero-details__stat-icon">${STAR_ICON}</span>
          <span class="hero-details__stat-value">—</span>
        </button>
      </div>
    `;
    dom.heroDetails.querySelector('[data-community-signal="stars"]')?.addEventListener("click", () => {
      onFavoriteToggle?.(episode);
    });
    updateCommunityStats(episode);
    requestAnimationFrame(updateHeroCoverSize);
    requestAnimationFrame(updateHeroTitleMarquee);
  }

  function updateCommunityStats(episode) {
    if (!episode || dom.heroDetails.querySelector('[data-community-signal="stars"]') === null) return;
    const signals = communitySignals?.getEpisodeSignals(episode.episodeKey) || {
      stars: null,
      views: null,
    };
    const starButton = dom.heroDetails.querySelector('[data-community-signal="stars"]');
    const starValue = starButton?.querySelector(".hero-details__stat-value");
    const isFavorite = favoritesStore?.has(episode) ?? false;
    if (starValue) starValue.textContent = formatCommunityCount(signals.stars);
    starButton?.setAttribute("aria-pressed", String(isFavorite));
    starButton?.setAttribute(
      "aria-label",
      `${isFavorite ? "Remove from favorites" : "Add to favorites"}, ${formatCommunityCount(signals.stars)} total stars`,
    );
  }

  communitySignals?.subscribe((changedKeys) => {
    const episode = state.visibleEpisodes.find((item) => item.id === state.selectedEpisodeId);
    if (!episode || (changedKeys.size && !changedKeys.has(episode.episodeKey))) return;
    updateCommunityStats(episode);
    requestAnimationFrame(updateHeroCoverSize);
  });

  function updateHeroCoverSize() {
    if (!dom.heroPanel || !dom.heroCoverFrame) return;

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
    const detailsHeight = dom.heroDetails.hidden
      ? 0
      : dom.heroDetails.offsetHeight
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
