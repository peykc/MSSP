const DRAG_ACTIVATE_PX = 8;
const DRAG_VELOCITY_THRESHOLD = 0.45;
const DRAG_COMPLETE_FRACTION = 0.28;
const CLICK_SUPPRESS_MS = 350;
const SLIDE_MS = 420;

export function createPatreonRssModal({ dom, patreonSources, getEpisodes, onSourcesChanged }) {
  let restoreFocusTo = null;
  let busy = false;
  let isOpen = false;
  let guideOpen = false;
  let closeTransitionEnd = null;
  let closeFallbackTimer = null;
  let isDragging = false;
  let gesture = null;
  let dragTranslate = 0;
  let suppressClickUntil = 0;

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prefersSlideAnimation = () =>
    !prefersReducedMotion() && window.matchMedia("(max-width: 520px)").matches;

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

  function setGuideOpen(open) {
    guideOpen = Boolean(open);
    dom.patreonRssGuide.hidden = !guideOpen;
    dom.patreonRssBody.hidden = guideOpen;
    dom.patreonRssInfo.setAttribute("aria-expanded", String(guideOpen));
    dom.patreonRssInfo.setAttribute(
      "aria-label",
      guideOpen ? "Back to RSS connection" : "How to find your RSS link",
    );
    if (guideOpen) {
      requestAnimationFrame(() => {
        const firstLink = dom.patreonRssGuide.querySelector("a");
        firstLink?.focus();
      });
    }
  }

  function open(trigger = document.activeElement) {
    restoreFocusTo = trigger;
    const storedUrl = patreonSources.getStoredUrl();
    const connected = patreonSources.isConnected();
    const hasConnection = connected || Boolean(storedUrl);
    dom.patreonRssInput.value = storedUrl;
    setRevealed(false);
    setStatus("");
    setGuideOpen(false);
    dom.patreonRssTitle.textContent = hasConnection ? "Manage Patreon RSS" : "Connect Patreon RSS";
    dom.patreonRssSubmit.textContent = hasConnection ? "Replace" : "Connect";
    dom.patreonRssRemove.hidden = !hasConnection;
    clearPendingClose();
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
      dom.patreonRssTitle.textContent = "Patreon RSS connected";
      dom.patreonRssSubmit.textContent = "Replace";
      dom.patreonRssRemove.hidden = false;
      setStatus(`${result.matched} PAYTCH episodes unlocked. ${result.unmatchedEpisodes} still need a match.`, "success");
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
    } catch (error) {
      setStatus(error?.message || "The private RSS connection could not be removed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value) {
    busy = Boolean(value);
    dom.patreonRssInput.disabled = busy;
    dom.patreonRssReveal.disabled = busy;
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

  function setRevealed(revealed) {
    dom.patreonRssInput.type = revealed ? "url" : "password";
    dom.patreonRssReveal.textContent = revealed ? "Hide" : "Show";
    dom.patreonRssReveal.setAttribute("aria-label", `${revealed ? "Hide" : "Show"} private RSS link`);
    dom.patreonRssReveal.setAttribute("aria-pressed", String(revealed));
  }

  function toggleGuide() {
    if (guideOpen) {
      setGuideOpen(false);
      requestAnimationFrame(() => dom.patreonRssInput.focus());
      return;
    }
    setGuideOpen(true);
  }

  function onKeydown(event) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (guideOpen) {
        setGuideOpen(false);
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
  dom.patreonRssReveal.addEventListener("click", () => setRevealed(dom.patreonRssInput.type === "password"));
  dom.patreonRssInfo.addEventListener("click", toggleGuide);
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

  return { close, open };
}
