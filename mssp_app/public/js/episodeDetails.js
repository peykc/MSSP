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
    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const accessLabel = episode.paytch ? "PAYTCH" : "Public";
    dom.heroDetails.innerHTML = `
      <span class="hero-details__heading">
        <span class="hero-details__heading-inner">
          <span class="hero-details__episode">${episodeLabel}</span>
          <span class="hero-details__title">
            <span class="hero-details__title-text">${episode.title || "Untitled episode"}</span>
          </span>
        </span>
      </span>
      <span>${episode.type || "MSSP"} - ${accessLabel}</span>
      <span>${episode.date || "Unknown date"}</span>
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
    const title = dom.heroDetails.querySelector(".hero-details__title");
    const titleText = dom.heroDetails.querySelector(".hero-details__title-text");
    if (!title || !titleText) return;

    titleText.getAnimations().forEach((animation) => animation.cancel());
    titleText.style.transform = "";
    titleText.style.opacity = "";
    title.classList.remove("is-marquee");
    title.style.removeProperty("--marquee-distance");
    title.style.removeProperty("--marquee-duration");

    const distance = titleText.scrollWidth - title.clientWidth;
    if (distance <= 2) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const holdMs = 1000;
    const fadeMs = 280;
    const resetMs = 120;
    const speedPxPerSecond = 42;
    const scrollMs = Math.max(4200, Math.min(18000, (distance / speedPxPerSecond) * 1000));
    const duration = holdMs + scrollMs + holdMs + fadeMs + resetMs + fadeMs;

    title.style.setProperty("--marquee-distance", `${distance}px`);
    title.style.setProperty("--marquee-duration", `${duration}ms`);
    title.classList.add("is-marquee");

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
