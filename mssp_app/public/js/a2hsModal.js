const SLIDE_MS = 420;

function isStandaloneDisplayMode() {
  return window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
}

export function isCoarsePointer() {
  return window.matchMedia("(pointer: coarse)").matches;
}

export function isIosDevice() {
  const ua = window.navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
}

export function createA2hsModal({ dom }) {
  let restoreFocusTo = null;
  let isOpen = false;
  let closeTransitionEnd = null;
  let closeFallbackTimer = null;

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prefersSlideAnimation = () => !prefersReducedMotion();

  function clearPendingClose() {
    if (closeTransitionEnd) {
      dom.a2hsModal.removeEventListener("transitionend", closeTransitionEnd);
      closeTransitionEnd = null;
    }
    if (closeFallbackTimer !== null) {
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    }
  }

  function open(trigger = document.activeElement) {
    if (isOpen) return;
    restoreFocusTo = trigger;
    clearPendingClose();
    dom.a2hsModal.classList.remove("is-leaving");
    dom.a2hsModal.hidden = false;
    dom.a2hsModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("a2hs-open");
    isOpen = true;

    if (prefersSlideAnimation()) {
      dom.a2hsModal.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dom.a2hsModal.classList.remove("is-entering"));
      });
    }

    requestAnimationFrame(() => dom.a2hsClose.focus());
  }

  function finishClose() {
    clearPendingClose();
    dom.a2hsModal.classList.remove("is-leaving", "is-entering");
    dom.a2hsModal.hidden = true;
    dom.a2hsModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("a2hs-open");
    restoreFocusTo?.focus?.();
    restoreFocusTo = null;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    if (!prefersSlideAnimation()) {
      finishClose();
      return;
    }

    dom.a2hsModal.classList.add("is-leaving");
    closeTransitionEnd = (event) => {
      if (event.target !== dom.a2hsDialog || event.propertyName !== "transform") return;
      clearPendingClose();
      finishClose();
    };
    dom.a2hsModal.addEventListener("transitionend", closeTransitionEnd);
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null;
      if (closeTransitionEnd) {
        dom.a2hsModal.removeEventListener("transitionend", closeTransitionEnd);
        closeTransitionEnd = null;
      }
      finishClose();
    }, SLIDE_MS);
  }

  function handleKeydown(event) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  dom.a2hsClose.addEventListener("click", close);
  dom.a2hsDragHandle.addEventListener("click", close);
  dom.a2hsModal.addEventListener("click", (event) => {
    if (event.target === dom.a2hsModal) close();
  });
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
  };
}

export function initAddToHomeScreen({ dom, a2hsModal }) {
  let deferredPrompt = null;

  function shouldShowButton() {
    return isCoarsePointer() && !isStandaloneDisplayMode();
  }

  function syncButton() {
    dom.launchA2hsButton.hidden = !shouldShowButton();
  }

  async function promptInstall() {
    if (!deferredPrompt) return false;
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    promptEvent.prompt();
    try {
      await promptEvent.userChoice;
    } catch {
      // Browser may reject; keep listening for a later prompt.
    }
    syncButton();
    return true;
  }

  async function onClick(event) {
    if (isIosDevice()) {
      a2hsModal.open(event.currentTarget);
      return;
    }
    await promptInstall();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    syncButton();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    syncButton();
  });

  window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)")
    .addEventListener?.("change", syncButton);
  window.matchMedia("(pointer: coarse)").addEventListener?.("change", syncButton);

  dom.launchA2hsButton.addEventListener("click", onClick);
  syncButton();

  return { syncButton };
}
