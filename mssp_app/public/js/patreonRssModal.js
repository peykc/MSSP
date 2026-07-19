const DRAG_ACTIVATE_PX = 8;
const DRAG_VELOCITY_THRESHOLD = 0.45;
const DRAG_COMPLETE_FRACTION = 0.28;
const CLICK_SUPPRESS_MS = 350;
const SLIDE_MS = 420;
const GUIDE_RESIZE_MS = 300;

export function createPatreonRssModal({ dom, patreonSources, getEpisodes, onSourcesChanged }) {
  let restoreFocusTo = null;
  let busy = false;
  let isOpen = false;
  let guideOpen = false;
  let guideMode = null;
  let closeTransitionEnd = null;
  let closeFallbackTimer = null;
  let resizeAnimation = null;
  let resizeFallbackTimer = null;
  let isDragging = false;
  let gesture = null;
  let dragTranslate = 0;
  let suppressClickUntil = 0;

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prefersSlideAnimation = () => !prefersReducedMotion();
  const preferredGuideMode = () =>
    window.matchMedia("(pointer: coarse)").matches ? "app" : "web";

  function clearPendingClose() {
    if (closeTransitionEnd) {
      dom.patreonRssModal.removeEventListener("transitionend", closeTransitionEnd);
      closeTransitionEnd = null;
    }
    if (closeFallbackTimer !== null) {
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    }
  }

  function clearPendingResize() {
    if (resizeAnimation) {
      const animation = resizeAnimation;
      resizeAnimation = null;
      animation.cancel();
    }
    if (resizeFallbackTimer !== null) {
      clearTimeout(resizeFallbackTimer);
      resizeFallbackTimer = null;
    }
    dom.patreonRssDialog.classList.remove("is-resizing");
  }

  function clampValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sheetHeight() {
    return dom.patreonRssDialog.getBoundingClientRect().height || window.innerHeight;
  }

  function setSheetTranslate(translate) {
    const height = gesture?.height || sheetHeight() || window.innerHeight;
    dragTranslate = clampValue(translate, 0, height);
    const progress = height > 0 ? 1 - (dragTranslate / height) : 0;
    dom.patreonRssDialog.style.transform = `translateY(${dragTranslate}px)`;
    dom.patreonRssModal.style.opacity = String(clampValue(progress, 0, 1));
  }

  function startDragVisuals() {
    isDragging = true;
    dom.patreonRssModal.classList.remove("is-entering", "is-leaving");
    dom.patreonRssModal.classList.add("is-dragging");
    document.body.classList.add("patreon-rss-dragging");
  }

  function endDragVisuals() {
    isDragging = false;
    dom.patreonRssModal.classList.remove("is-dragging");
    document.body.classList.remove("patreon-rss-dragging");
    dom.patreonRssDialog.style.transform = "";
    dom.patreonRssModal.style.opacity = "";
  }

  function setGuideMode(mode, { focus = false } = {}) {
    guideMode = mode === "app" ? "app" : "web";
    const appSelected = guideMode === "app";
    const selectedVisual = appSelected ? dom.patreonRssAppGuideVisual : dom.patreonRssWebGuideVisual;
    selectedVisual.prepend(dom.patreonRssGuideSwitch);
    const pairs = [
      [dom.patreonRssWebGuideTab, dom.patreonRssWebGuide, !appSelected],
      [dom.patreonRssAppGuideTab, dom.patreonRssAppGuide, appSelected],
    ];

    pairs.forEach(([tab, panel, selected]) => {
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.classList.toggle("is-active", selected);
      panel.hidden = !selected;
    });

    if (focus) pairs.find(([, , selected]) => selected)?.[0].focus();
  }

  function applyGuideOpen(open) {
    guideOpen = Boolean(open);
    dom.patreonRssGuide.hidden = !guideOpen;
    dom.patreonRssGuideSwitch.hidden = !guideOpen;
    dom.patreonRssBody.hidden = guideOpen;
    dom.patreonRssInfo.setAttribute("aria-expanded", String(guideOpen));
    dom.patreonRssInfo.setAttribute(
      "aria-label",
      guideOpen ? "Back to RSS connection" : "How to find your RSS link",
    );
    if (guideOpen) {
      if (!guideMode) {
        setGuideMode(preferredGuideMode());
      }
      requestAnimationFrame(() => {
        (guideMode === "app" ? dom.patreonRssAppGuideTab : dom.patreonRssWebGuideTab).focus();
      });
    }
  }

  function setGuideOpen(open, { animate = false } = {}) {
    const nextOpen = Boolean(open);
    if (!animate || !isOpen || nextOpen === guideOpen || prefersReducedMotion()) {
      clearPendingResize();
      applyGuideOpen(nextOpen);
      return;
    }

    const startHeight = dom.patreonRssDialog.getBoundingClientRect().height;
    clearPendingResize();
    applyGuideOpen(nextOpen);
    const targetHeight = dom.patreonRssDialog.getBoundingClientRect().height;

    if (Math.abs(targetHeight - startHeight) < 1) {
      return;
    }

    dom.patreonRssDialog.classList.add("is-resizing");
    const animation = dom.patreonRssDialog.animate([
      { height: `${startHeight}px` },
      { height: `${targetHeight}px` },
    ], {
      duration: GUIDE_RESIZE_MS,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
    resizeAnimation = animation;

    const finishResize = () => {
      if (resizeAnimation !== animation) return;
      resizeAnimation = null;
      if (resizeFallbackTimer !== null) {
        clearTimeout(resizeFallbackTimer);
        resizeFallbackTimer = null;
      }
      dom.patreonRssDialog.classList.remove("is-resizing");
    };
    animation.addEventListener("finish", finishResize, { once: true });
    resizeFallbackTimer = setTimeout(() => {
      if (resizeAnimation === animation) animation.finish();
    }, GUIDE_RESIZE_MS + 80);
  }

  function onGuideTabKeydown(event) {
    const tabs = [dom.patreonRssWebGuideTab, dom.patreonRssAppGuideTab];
    const currentIndex = tabs.indexOf(event.currentTarget);
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setGuideMode(nextIndex === 0 ? "web" : "app", { focus: true });
  }

  function open(trigger = document.activeElement) {
    restoreFocusTo = trigger;
    const storedUrl = patreonSources.getStoredUrl();
    const connected = patreonSources.isConnected();
    const hasConnection = connected || Boolean(storedUrl);
    dom.patreonRssInput.value = storedUrl;
    setStatus("");
    setGuideOpen(false);
    if (!guideMode) {
      setGuideMode(preferredGuideMode());
    }
    dom.patreonRssTitle.textContent = hasConnection ? "Manage Patreon RSS" : "Connect Patreon RSS";
    dom.patreonRssSubmit.textContent = hasConnection ? "Replace" : "Connect";
    dom.patreonRssRemove.hidden = !hasConnection;
    clearPendingClose();
    clearPendingResize();
    endDragVisuals();
    gesture = null;
    dom.patreonRssModal.classList.remove("is-leaving");
    dom.patreonRssModal.hidden = false;
    dom.patreonRssModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("patreon-rss-open");
    isOpen = true;

    if (prefersSlideAnimation()) {
      dom.patreonRssModal.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dom.patreonRssModal.classList.remove("is-entering"));
      });
    }

    requestAnimationFrame(() => dom.patreonRssInput.focus());
  }

  function finishClose() {
    clearPendingClose();
    clearPendingResize();
    endDragVisuals();
    gesture = null;
    dom.patreonRssModal.classList.remove("is-leaving", "is-entering", "is-dragging");
    dom.patreonRssModal.hidden = true;
    dom.patreonRssModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("patreon-rss-open", "patreon-rss-dragging");
    dom.patreonRssInput.value = "";
    setStatus("");
    setGuideOpen(false);
    restoreFocusTo?.focus?.();
    restoreFocusTo = null;
  }

  function beginAnimatedClose() {
    if (!prefersSlideAnimation()) {
      finishClose();
      return;
    }

    dom.patreonRssModal.classList.add("is-leaving");
    requestAnimationFrame(() => {
      dom.patreonRssDialog.style.transform = "";
      dom.patreonRssModal.style.opacity = "";
    });
    closeTransitionEnd = (event) => {
      if (event.target !== dom.patreonRssDialog || event.propertyName !== "transform") return;
      clearPendingClose();
      finishClose();
    };
    dom.patreonRssModal.addEventListener("transitionend", closeTransitionEnd);
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null;
      if (closeTransitionEnd) {
        dom.patreonRssModal.removeEventListener("transitionend", closeTransitionEnd);
        closeTransitionEnd = null;
      }
      finishClose();
    }, SLIDE_MS);
  }

  function close() {
    if (!isOpen || busy || isDragging) return;
    clearPendingResize();
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
    dom.patreonRssModal.classList.remove("is-dragging");
    document.body.classList.remove("patreon-rss-dragging");
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    beginAnimatedClose();
  }

  function onDragPointerDown(event) {
    if (!prefersSlideAnimation() || gesture || isDragging || !isOpen || busy) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const onHandle = Boolean(event.target.closest(".patreon-rss-dialog__drag"));
    if (!onHandle) {
      if (dom.patreonRssDialog.scrollTop > 0) return;
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

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus("Checking your Patreon link…");
    try {
      const result = await patreonSources.connect(dom.patreonRssInput.value, getEpisodes(), {
        persist: true,
      });
      await onSourcesChanged();
      dom.patreonRssTitle.textContent = "Manage Patreon RSS";
      dom.patreonRssSubmit.textContent = "Replace";
      dom.patreonRssRemove.hidden = false;
      if (result.unmatchedEpisodeKeys?.length) {
        console.warn("[MSSP] PAYTCH episodes still unmatched:", result.unmatchedEpisodeKeys);
      }
      setStatus(
        result.unmatchedEpisodes === 0
          ? "All PAYTCH episodes unlocked."
          : `${result.matched} PAYTCH episodes unlocked. ${result.unmatchedEpisodes} still need a match.`,
        "success",
      );
      syncLaunchButton();
    } catch (error) {
      setStatus(error?.name === "PatreonRssConnectionError" ? error.message : "That link could not be connected. Double-check it and try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      patreonSources.disconnect();
      await onSourcesChanged();
      dom.patreonRssInput.value = "";
      dom.patreonRssTitle.textContent = "Connect Patreon RSS";
      dom.patreonRssSubmit.textContent = "Connect";
      dom.patreonRssRemove.hidden = true;
      setStatus("Your link was removed from this device.", "success");
      syncLaunchButton();
    } catch (error) {
      setStatus(error?.message || "The private RSS connection could not be removed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value) {
    busy = Boolean(value);
    dom.patreonRssInput.disabled = busy;
    dom.patreonRssSubmit.disabled = busy;
    dom.patreonRssCancel.disabled = busy;
    dom.patreonRssRemove.disabled = busy;
    dom.patreonRssSubmit.textContent = busy ? "Connecting…" : (patreonSources.isConnected() ? "Replace" : "Connect");
  }

  function setStatus(message, kind = "") {
    dom.patreonRssStatus.textContent = message;
    dom.patreonRssStatus.classList.toggle("is-error", kind === "error");
    dom.patreonRssStatus.classList.toggle("is-success", kind === "success");
  }

  function syncLaunchButton() {
    const linked = patreonSources.isConnected() || Boolean(patreonSources.getStoredUrl());
    const label = dom.patreonRssLogoButton.querySelector(".launch__paytch-link__label");
    dom.patreonRssLogoButton.classList.toggle("is-linked", linked);
    dom.patreonRssLogoButton.setAttribute("aria-label", linked ? "Manage PAYTCH" : "Link PAYTCH");
    if (label) {
      label.textContent = linked ? "" : "Link PAYTCH";
      label.hidden = linked;
    }
  }

  function toggleGuide() {
    if (guideOpen) {
      setGuideOpen(false, { animate: true });
      requestAnimationFrame(() => dom.patreonRssInput.focus());
      return;
    }
    setGuideOpen(true, { animate: true });
  }

  function onKeydown(event) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (guideOpen) {
        setGuideOpen(false, { animate: true });
        requestAnimationFrame(() => dom.patreonRssInput.focus());
        return;
      }
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dom.patreonRssDialog.querySelectorAll("button:not([disabled]):not([hidden]), input:not([disabled]), a[href]")]
      .filter((element) => !element.closest("[hidden]"));
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

  dom.patreonRssLogoButton.addEventListener("click", (event) => open(event.currentTarget));
  dom.patreonRssForm.addEventListener("submit", submit);
  dom.patreonRssInfo.addEventListener("click", toggleGuide);
  dom.patreonRssWebGuideTab.addEventListener("click", () => setGuideMode("web", { focus: true }));
  dom.patreonRssAppGuideTab.addEventListener("click", () => setGuideMode("app", { focus: true }));
  dom.patreonRssWebGuideTab.addEventListener("keydown", onGuideTabKeydown);
  dom.patreonRssAppGuideTab.addEventListener("keydown", onGuideTabKeydown);
  dom.patreonRssCancel.addEventListener("click", close);
  dom.patreonRssRemove.addEventListener("click", remove);
  dom.patreonRssDragHandle.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
      return;
    }
    close();
  });
  dom.patreonRssModal.addEventListener("click", (event) => {
    if (event.target === dom.patreonRssModal) close();
  });
  dom.patreonRssDialog.addEventListener("pointerdown", onDragPointerDown);
  dom.patreonRssDialog.addEventListener("click", maybeSwallowClick, true);
  window.addEventListener("pointermove", onDragPointerMove, { passive: false });
  window.addEventListener("pointerup", onDragPointerUp);
  window.addEventListener("pointercancel", onDragPointerUp);
  document.addEventListener("keydown", onKeydown);

  syncLaunchButton();

  return { close, open, syncLaunchButton };
}
