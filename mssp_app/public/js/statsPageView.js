export function createStatsPageView({ dom }) {
  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let returnFocus = null;

  function setLaunchCovered(covered) {
    dom.launchView.classList.toggle("is-covered", covered);
    document.body.classList.toggle("stats-open", covered);
    dom.launchView.inert = covered;
    if (covered) {
      dom.launchView.setAttribute("aria-hidden", "true");
    } else {
      dom.launchView.removeAttribute("aria-hidden");
    }
  }

  function revealStats() {
    dom.statsView.classList.remove("is-hidden", "is-leaving");
    if (prefersReducedMotion()) return;

    dom.statsView.classList.add("is-entering");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        dom.statsView.classList.remove("is-entering");
      });
    });
  }

  function open(trigger = document.activeElement) {
    if (!dom.statsView.classList.contains("is-hidden")) return;
    returnFocus = trigger instanceof HTMLElement ? trigger : null;
    setLaunchCovered(true);
    dom.statsViewScroller.scrollTop = 0;
    dom.statsView.inert = false;
    dom.statsView.setAttribute("aria-hidden", "false");
    revealStats();
    dom.statsBackButton.focus({ preventScroll: true });
  }

  function finishClose() {
    dom.statsView.classList.remove("is-leaving");
    dom.statsView.classList.add("is-hidden");
    dom.statsView.inert = true;
    dom.statsView.setAttribute("aria-hidden", "true");
    setLaunchCovered(false);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function close() {
    if (dom.statsView.classList.contains("is-hidden")) return;

    if (prefersReducedMotion()) {
      finishClose();
      return;
    }

    dom.statsView.classList.add("is-leaving");
    const onTransitionEnd = (event) => {
      if (event.target !== dom.statsView || event.propertyName !== "transform") return;
      dom.statsView.removeEventListener("transitionend", onTransitionEnd);
      finishClose();
    };
    dom.statsView.addEventListener("transitionend", onTransitionEnd);
  }

  dom.statsBackButton.addEventListener("click", close);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || dom.statsView.classList.contains("is-hidden")) return;
    event.preventDefault();
    close();
  });

  return { close, open };
}
