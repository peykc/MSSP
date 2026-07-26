import { SHARE_ICON, shareEpisode } from "./episodeRow.js?v=share-short-a";

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 8;

function isFineHoverPointer() {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/**
 * Attach long-press (coarse) + hover share button (fine) to a row/passage.
 * @param {HTMLElement} host
 * @param {{
 *   getEpisode: () => object | null | undefined,
 *   getShareTime: () => number,
 *   variant?: "search" | "transcript",
 *   suppressClickAfterShare?: boolean,
 * }} options
 */
export function bindShareMoment(host, {
  getEpisode,
  getShareTime,
  variant = "search",
  suppressClickAfterShare = true,
} = {}) {
  if (!host || typeof getEpisode !== "function" || typeof getShareTime !== "function") {
    return () => {};
  }

  host.classList.add("share-moment-host");
  host.classList.add(`share-moment-host--${variant}`);

  const overlay = document.createElement("span");
  overlay.className = `share-moment__overlay share-moment__overlay--${variant}`;
  overlay.setAttribute("aria-hidden", "true");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "share-moment__button";
  button.setAttribute("aria-label", "Share this moment");
  // Search + transcript share are hover-only; don't leave a focused control after click.
  button.tabIndex = -1;
  button.innerHTML = SHARE_ICON;
  overlay.append(button);
  host.append(overlay);

  let pressTimer = null;
  let pressOrigin = null;
  let suppressClick = false;
  let sharing = false;

  async function runShare(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (sharing) return;
    const episode = getEpisode();
    if (!episode?.episodeKey) return;
    const t = getShareTime();
    if (!Number.isFinite(Number(t)) || Number(t) < 0) return;
    sharing = true;
    try {
      await shareEpisode(episode, { t });
    } finally {
      sharing = false;
      button.blur();
      if (typeof host.blur === "function") host.blur();
    }
  }

  function clearPress() {
    if (pressTimer != null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressOrigin = null;
  }

  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest(".share-moment__button")) return;
    // Desktop uses the hover button; long-press is for touch / pen / coarse.
    if (event.pointerType === "mouse" && isFineHoverPointer()) return;

    clearPress();
    pressOrigin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      if (suppressClickAfterShare) suppressClick = true;
      void runShare(event);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event) {
    if (!pressOrigin || event.pointerId !== pressOrigin.pointerId) return;
    const dx = event.clientX - pressOrigin.x;
    const dy = event.clientY - pressOrigin.y;
    if ((dx * dx) + (dy * dy) > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
      clearPress();
    }
  }

  function onPointerUp(event) {
    if (pressOrigin && event.pointerId === pressOrigin.pointerId) clearPress();
  }

  function onClickCapture(event) {
    if (event.target.closest(".share-moment__button")) {
      event.preventDefault();
      event.stopPropagation();
      void runShare(event);
      return;
    }
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function onShareMouseDown(event) {
    // Keep click working but don't focus the control (hover-only UI).
    event.preventDefault();
  }

  function onContextMenu(event) {
    // Avoid native callout competing with long-press share on touch.
    if (!isFineHoverPointer()) {
      event.preventDefault();
    }
  }

  function onSelectStart(event) {
    // Block hold-to-select so long-press share isn't fighting native selection.
    if (!isFineHoverPointer()) {
      event.preventDefault();
    }
  }

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  host.addEventListener("click", onClickCapture, true);
  host.addEventListener("contextmenu", onContextMenu);
  host.addEventListener("selectstart", onSelectStart);
  button.addEventListener("mousedown", onShareMouseDown);

  return () => {
    clearPress();
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onPointerUp);
    host.removeEventListener("click", onClickCapture, true);
    host.removeEventListener("contextmenu", onContextMenu);
    host.removeEventListener("selectstart", onSelectStart);
    button.removeEventListener("mousedown", onShareMouseDown);
    overlay.remove();
    host.classList.remove("share-moment-host", `share-moment-host--${variant}`);
  };
}
