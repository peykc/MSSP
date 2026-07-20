const DRAG_ACTIVATE_PX = 8;
const DRAG_VELOCITY_THRESHOLD = 0.45;
const DRAG_COMPLETE_FRACTION = 0.28;
const CLICK_SUPPRESS_MS = 350;
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
  let isDragging = false;
  let gesture = null;
  let dragTranslate = 0;
  let suppressClickUntil = 0;

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

  function clampValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sheetHeight() {
    return dom.a2hsDialog.getBoundingClientRect().height || window.innerHeight;
  }

  function setSheetTranslate(translate) {
    const height = gesture?.height || sheetHeight() || window.innerHeight;
    dragTranslate = clampValue(translate, 0, height);
    const progress = height > 0 ? 1 - (dragTranslate / height) : 0;
    dom.a2hsDialog.style.transform = `translateY(${dragTranslate}px)`;
    dom.a2hsModal.style.opacity = String(clampValue(progress, 0, 1));
  }

  function startDragVisuals() {
    isDragging = true;
    dom.a2hsModal.classList.remove("is-entering", "is-leaving");
    dom.a2hsModal.classList.add("is-dragging");
    document.body.classList.add("a2hs-dragging");
  }

  function endDragVisuals() {
    isDragging = false;
    dom.a2hsModal.classList.remove("is-dragging");
    document.body.classList.remove("a2hs-dragging");
    dom.a2hsDialog.style.transform = "";
    dom.a2hsModal.style.opacity = "";
  }

  function open(trigger = document.activeElement) {
    if (isOpen) return;
    restoreFocusTo = trigger;
    clearPendingClose();
    endDragVisuals();
    gesture = null;
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

    requestAnimationFrame(() => dom.a2hsDialog.focus());
  }

  function finishClose() {
    clearPendingClose();
    endDragVisuals();
    gesture = null;
    dom.a2hsModal.classList.remove("is-leaving", "is-entering", "is-dragging");
    dom.a2hsModal.hidden = true;
    dom.a2hsModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("a2hs-open", "a2hs-dragging");
    restoreFocusTo?.focus?.();
    restoreFocusTo = null;
  }

  function beginAnimatedClose() {
    if (!prefersSlideAnimation()) {
      finishClose();
      return;
    }

    dom.a2hsModal.classList.add("is-leaving");
    requestAnimationFrame(() => {
      dom.a2hsDialog.style.transform = "";
      dom.a2hsModal.style.opacity = "";
    });
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

  function close() {
    if (!isOpen || isDragging) return;
    isOpen = false;
    beginAnimatedClose();
  }

  function settleDrag(shouldOpen) {
    if (shouldOpen) {
      endDragVisuals();
      return;
    }

    if (!isOpen) return;
    isOpen = false;
    isDragging = false;
    dom.a2hsModal.classList.remove("is-dragging");
    document.body.classList.remove("a2hs-dragging");
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    beginAnimatedClose();
  }

  function onDragPointerDown(event) {
    if (!prefersSlideAnimation() || gesture || isDragging || !isOpen) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const onHandle = Boolean(event.target.closest(".patreon-rss-dialog__drag"));
    if (!onHandle) {
      if (dom.a2hsDialog.scrollTop > 0) return;
      if (event.target.closest("button, input, a, textarea, select, label")) return;
    }

    gesture = {
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp || performance.now(),
      velocity: 0,
      height: sheetHeight(),
      pointerId: event.pointerId,
      target: event.currentTarget,
      active: false,
    };
  }

  function activateGesture(event) {
    gesture.active = true;
    startDragVisuals();
    setSheetTranslate(0);
    gesture.target.setPointerCapture?.(event.pointerId);
  }

  function onDragPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dyDown = event.clientY - gesture.startY;
    const dyUp = -dyDown;

    if (!gesture.active) {
      const horizontal = Math.abs(dx);
      if (dyDown > DRAG_ACTIVATE_PX && dyDown > horizontal) {
        activateGesture(event);
      } else if (dyUp > DRAG_ACTIVATE_PX) {
        gesture = null;
        return;
      } else {
        return;
      }
    }

    event.preventDefault();
    setSheetTranslate(Math.max(0, dyDown));

    const now = event.timeStamp || performance.now();
    const dt = now - gesture.lastTime;
    if (dt > 0) gesture.velocity = (event.clientY - gesture.lastY) / dt;
    gesture.lastY = event.clientY;
    gesture.lastTime = now;
  }

  function onDragPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if (!g.active) return;

    g.target.releasePointerCapture?.(event.pointerId);
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;

    const height = g.height;
    const progress = height > 0 ? 1 - (dragTranslate / height) : 0;
    const velocity = g.velocity;

    let shouldOpen;
    if (velocity > DRAG_VELOCITY_THRESHOLD) shouldOpen = false;
    else if (velocity < -DRAG_VELOCITY_THRESHOLD) shouldOpen = true;
    else shouldOpen = progress > (1 - DRAG_COMPLETE_FRACTION);

    settleDrag(shouldOpen);
  }

  function maybeSwallowClick(event) {
    if (performance.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
      suppressClickUntil = 0;
    }
  }

  function handleKeydown(event) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  async function shareCurrentPage() {
    const url = window.location.href;
    const title = document.title || "Matt and Shane's Secret Podcast";
    const shareData = { title, url };

    if (!navigator.share) return;

    try {
      if (navigator.canShare && !navigator.canShare(shareData)) return;
      await navigator.share(shareData);
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  dom.a2hsDragHandle.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
      return;
    }
    close();
  });
  dom.a2hsShareButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void shareCurrentPage();
  });
  dom.a2hsModal.addEventListener("click", (event) => {
    if (event.target === dom.a2hsModal) close();
  });
  dom.a2hsDialog.addEventListener("pointerdown", onDragPointerDown);
  dom.a2hsDialog.addEventListener("click", maybeSwallowClick, true);
  window.addEventListener("pointermove", onDragPointerMove, { passive: false });
  window.addEventListener("pointerup", onDragPointerUp);
  window.addEventListener("pointercancel", onDragPointerUp);
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
