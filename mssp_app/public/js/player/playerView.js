export function createPlayerView({ dom, playerState }) {
  let restoreFocusTo = null;
  let wasExpanded = false;

  function render(state) {
    const episode = state.selectedEpisode;
    const hasEpisode = Boolean(episode);
    dom.miniPlayer.hidden = !hasEpisode;
    document.body.classList.toggle("has-player", hasEpisode);

    if (!hasEpisode) {
      setExpandedUi(false);
      return;
    }

    const episodeLabel = episode.episode ? `Ep. ${episode.episode}` : "Extra";
    const accessLabel = episode.paytch === "PAYTCH" ? "PAYTCH" : "Public";
    const source = state.sourceStatus;
    const queuePosition = playerState.getQueuePosition();

    dom.miniPlayerCover.src = episode.coverUrl;
    dom.miniPlayerCover.alt = "";
    dom.miniPlayerTitle.textContent = `${episodeLabel} - ${episode.title || "Untitled episode"}`;
    dom.miniPlayerStatus.textContent = source.label;

    dom.fullPlayerCover.src = episode.coverUrl;
    dom.fullPlayerCover.alt = `${episode.title || "Selected episode"} cover`;
    dom.fullPlayerEyebrow.textContent = `${episode.type || "MSSP"} ${accessLabel} ${episodeLabel}`;
    dom.fullPlayerTitle.textContent = episode.title || "Untitled episode";
    dom.fullPlayerMeta.textContent = `${episode.date || "Unknown date"} · ${accessLabel}`;
    dom.fullPlayerStatus.textContent = source.label;
    dom.fullPlayerStatusDetail.textContent = source.detail;
    dom.playerPrevious.disabled = !queuePosition.hasPrevious;
    dom.playerNext.disabled = !queuePosition.hasNext;
    setExpandedUi(state.isExpanded);
    if (state.isExpanded && !wasExpanded) {
      requestAnimationFrame(() => dom.fullPlayerCollapse.focus());
    }
    wasExpanded = state.isExpanded;
  }

  function expand(trigger = document.activeElement) {
    if (!playerState.getState().selectedEpisode) return;
    restoreFocusTo = trigger;
    playerState.setExpanded(true);
  }

  function collapse() {
    if (!playerState.getState().isExpanded) return;
    playerState.setExpanded(false);
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected ? restoreFocusTo : dom.miniPlayerExpand;
      target.focus();
      restoreFocusTo = null;
    });
  }

  function setExpandedUi(isExpanded) {
    dom.fullPlayer.hidden = !isExpanded;
    dom.playerBackdrop.hidden = !isExpanded;
    dom.fullPlayer.setAttribute("aria-hidden", String(!isExpanded));
    document.body.classList.toggle("player-expanded", isExpanded);
    dom.app.inert = isExpanded;
    dom.miniPlayer.inert = isExpanded;
    if (!isExpanded) wasExpanded = false;
  }

  function trapFocus(event) {
    if (event.key === "Escape") {
      collapse();
      return;
    }
    if (event.key !== "Tab" || !playerState.getState().isExpanded) return;

    const focusable = [...dom.fullPlayer.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dom.miniPlayerExpand.addEventListener("click", (event) => expand(event.currentTarget));
  dom.fullPlayerCollapse.addEventListener("click", collapse);
  dom.playerBackdrop.addEventListener("click", collapse);
  dom.playerPrevious.addEventListener("click", () => playerState.step(-1));
  dom.playerNext.addEventListener("click", () => playerState.step(1));
  document.addEventListener("keydown", trapFocus);
  playerState.subscribe(render);

  return {
    collapse,
    expand,
  };
}
