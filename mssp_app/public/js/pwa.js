const UPDATE_CHANNEL = "mssp-pwa-update-v1";
const OWNER_LEASE_MS = 10_000;
const ELECTION_WINDOW_MS = 100;
const PAUSE_DELAY_MS = 3_000;
const HARD_REFRESH_TIMEOUT_MS = 30_000;
const PULL_CLAIM_THRESHOLD = 8;
const PULL_REFRESH_THRESHOLD = 100;
const PULL_CYCLE_START_MS = 250;
const PULL_SPOKE_OPACITIES = [1, 0.88, 0.76, 0.64, 0.52, 0.40, 0.28, 0.16];
const PROTECTED_PLAYBACK_STATUSES = new Set([
  "loading_source",
  "buffering_playback",
  "playing",
]);

export function isStandalonePwa() {
  return window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches
    || window.navigator.standalone === true;
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register("./service-worker.js", {
      scope: "./",
    });
    console.info("[MSSP] Service worker scope:", registration.scope);
    return registration;
  } catch (error) {
    console.warn("[MSSP] Service worker registration failed.", error);
    return null;
  }
}

export function isPlaybackProtected(state) {
  return Boolean(
    state?.playbackRequested
    || PROTECTED_PLAYBACK_STATUSES.has(state?.playbackStatus)
  );
}

export function getPlaybackSafetyDelay(state) {
  if (isPlaybackProtected(state)) return Number.POSITIVE_INFINITY;
  return state?.playbackStatus === "paused" ? PAUSE_DELAY_MS : 0;
}

export function qualifiesPullGesture(deltaX, deltaY) {
  return deltaY > PULL_CLAIM_THRESHOLD && deltaY > Math.abs(deltaX) * 1.5;
}

export function getCacheBustedUrl(href, timestamp = Date.now()) {
  const url = new URL(href);
  url.searchParams.set("mssp-refresh", String(timestamp));
  return url.href;
}

export function isPreferredUpdateLease(candidate, current) {
  if (candidate.priority !== current.priority) return candidate.priority > current.priority;
  if (candidate.startedAt !== current.startedAt) return candidate.startedAt < current.startedAt;
  return candidate.ownerId < current.ownerId;
}

export function initPwaUpdates(registration, {
  getPlaybackState = () => null,
  subscribePlayback = () => () => {},
} = {}) {
  const ownerId = createOwnerId();
  const channel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(UPDATE_CHANNEL)
    : null;
  let waitingWorker = null;
  let installingWorker = null;
  let currentLease = null;
  let activationStarted = false;
  let initiatedActivation = false;
  let staleController = false;
  let knownController = navigator.serviceWorker.controller;
  let electionTimer = null;
  let leaseTimer = null;
  let safetyTimer = null;
  let reloadStarted = false;

  function playbackState() {
    return getPlaybackState?.() || null;
  }

  function clearSafetyTimer() {
    if (safetyTimer !== null) window.clearTimeout(safetyTimer);
    safetyTimer = null;
  }

  function scheduleWhenPlaybackSafe(callback) {
    clearSafetyTimer();
    const delay = getPlaybackSafetyDelay(playbackState());
    if (!Number.isFinite(delay)) return;
    if (delay === 0) {
      callback();
      return;
    }
    safetyTimer = window.setTimeout(() => {
      safetyTimer = null;
      if (getPlaybackSafetyDelay(playbackState()) === delay) callback();
    }, delay);
  }

  function pollForUpdates() {
    return registration.update()
      .catch(() => null)
      .finally(checkRegistrationWorkers);
  }

  function trackInstallingWorker(worker) {
    if (!worker || worker === installingWorker) return;
    installingWorker = worker;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        trackWaitingWorker(registration.waiting || worker);
      }
    });
  }

  function trackWaitingWorker(worker) {
    if (!worker || !navigator.serviceWorker.controller) return;
    waitingWorker = worker;
    scheduleActivation();
  }

  function checkRegistrationWorkers() {
    if (registration.waiting) trackWaitingWorker(registration.waiting);
    if (registration.installing) trackInstallingWorker(registration.installing);
  }

  function scheduleActivation() {
    if (!waitingWorker || activationStarted || document.visibilityState !== "visible") return;
    if (getPlaybackSafetyDelay(playbackState()) !== 0) {
      window.clearTimeout(electionTimer);
      electionTimer = null;
      if (currentLease?.ownerId === ownerId) currentLease = null;
    }
    scheduleWhenPlaybackSafe(beginElection);
  }

  function beginElection() {
    if (!waitingWorker || activationStarted || document.visibilityState !== "visible") return;
    const now = Date.now();
    if (currentLease?.expiresAt > now && currentLease.ownerId !== ownerId) {
      scheduleLeaseRetry(currentLease.expiresAt - now);
      return;
    }

    const lease = {
      type: "PWA_UPDATE_OWNER",
      ownerId,
      priority: document.hasFocus?.() ? 2 : 1,
      startedAt: now,
      expiresAt: now + OWNER_LEASE_MS,
    };
    currentLease = lease;
    channel?.postMessage(lease);
    window.clearTimeout(electionTimer);
    electionTimer = window.setTimeout(() => finalizeElection(lease), ELECTION_WINDOW_MS);
  }

  function finalizeElection(lease) {
    electionTimer = null;
    if (currentLease?.ownerId !== ownerId || currentLease.startedAt !== lease.startedAt) return;
    if (!waitingWorker || document.visibilityState !== "visible") return;
    if (isPlaybackProtected(playbackState())) {
      scheduleActivation();
      return;
    }

    activationStarted = true;
    initiatedActivation = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    scheduleLeaseRetry(Math.max(0, lease.expiresAt - Date.now()));
  }

  function scheduleLeaseRetry(delay) {
    window.clearTimeout(leaseTimer);
    leaseTimer = window.setTimeout(() => {
      leaseTimer = null;
      if (initiatedActivation && knownController === navigator.serviceWorker.controller) {
        activationStarted = false;
        initiatedActivation = false;
      }
      if (currentLease?.expiresAt <= Date.now()) currentLease = null;
      checkRegistrationWorkers();
      scheduleActivation();
    }, Math.max(0, delay) + 25);
  }

  function handleOwnerMessage(event) {
    const lease = normalizeLease(event.data);
    if (!lease || lease.ownerId === ownerId || lease.expiresAt <= Date.now()) return;

    if (!currentLease || currentLease.expiresAt <= Date.now() || isPreferredUpdateLease(lease, currentLease)) {
      currentLease = lease;
      if (!activationStarted) window.clearTimeout(electionTimer);
      scheduleLeaseRetry(lease.expiresAt - Date.now());
    } else if (currentLease.ownerId === ownerId) {
      channel?.postMessage(currentLease);
    }
  }

  function reloadWhenSafe() {
    if (!staleController || reloadStarted || document.visibilityState !== "visible") return;
    scheduleWhenPlaybackSafe(reloadPage);
  }

  function reloadPage() {
    if (reloadStarted) return;
    reloadStarted = true;
    window.location.reload();
  }

  function handleControllerChange() {
    const nextController = navigator.serviceWorker.controller;
    if (!knownController) {
      knownController = nextController;
      return;
    }
    knownController = nextController;
    waitingWorker = null;
    window.clearTimeout(leaseTimer);

    if (initiatedActivation) {
      reloadPage();
      return;
    }
    staleController = true;
    reloadWhenSafe();
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") {
      clearSafetyTimer();
      return;
    }
    void pollForUpdates();
    if (staleController) reloadWhenSafe();
    else scheduleActivation();
  }

  registration.addEventListener("updatefound", () => {
    trackInstallingWorker(registration.installing);
  });
  navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", pollForUpdates);
  channel?.addEventListener("message", handleOwnerMessage);

  const unsubscribePlayback = subscribePlayback(() => {
    if (staleController) reloadWhenSafe();
    else scheduleActivation();
  });

  checkRegistrationWorkers();
  void pollForUpdates();

  return () => {
    unsubscribePlayback?.();
    channel?.close();
    clearSafetyTimer();
    window.clearTimeout(electionTimer);
    window.clearTimeout(leaseTimer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", pollForUpdates);
    navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
  };
}

export function requestHardRefresh({
  controller = navigator.serviceWorker?.controller,
  timeoutMs = HARD_REFRESH_TIMEOUT_MS,
} = {}) {
  if (!controller) return Promise.reject(new Error("The app is not controlled by a service worker yet."));

  return new Promise((resolve, reject) => {
    const messageChannel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      messageChannel.port1.close();
      reject(new Error("The refresh timed out. Check your connection and try again."));
    }, timeoutMs);

    messageChannel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      messageChannel.port1.close();
      if (event.data?.ok) resolve(event.data.generation);
      else reject(new Error(event.data?.error?.message || "The refresh could not be completed."));
    };

    try {
      controller.postMessage({ type: "HARD_REFRESH" }, [messageChannel.port2]);
    } catch (error) {
      window.clearTimeout(timeout);
      messageChannel.port1.close();
      reject(error);
    }
  });
}

export async function refreshApplication() {
  if (navigator.serviceWorker?.controller) {
    await requestHardRefresh();
    window.location.reload();
    return;
  }

  // Service workers require HTTPS (except localhost), so LAN HTTP uses a cache-busted navigation.
  window.location.replace(getCacheBustedUrl(window.location.href));
}

export function initLaunchPullToRefresh({
  scroller,
  launchView,
  hardRefresh = refreshApplication,
} = {}) {
  const indicator = document.getElementById("pullRefreshIndicator");
  const label = document.getElementById("pullRefreshLabel");
  const spinner = indicator?.querySelector(".pull-refresh__spinner");
  let gesture = null;
  let refreshing = false;
  let resetTimer = null;
  let cycleTimer = null;

  if (!scroller || !launchView || !indicator || !label || !spinner) {
    return { cancel() {}, destroy() {} };
  }

  document.body.classList.add("pwa-pull-enabled");

  function launchIsEligible() {
    return document.visibilityState === "visible"
      && !launchView.classList.contains("is-covered")
      && !document.body.matches(".library-open, .stats-open, .calendar-open, .patreon-rss-open, .player-expanded")
      && scroller.scrollTop <= 1;
  }

  function onTouchStart(event) {
    if (refreshing || event.touches.length !== 1 || !launchIsEligible()) return;
    if (!launchView.contains(event.target)) return;
    const touch = event.touches[0];
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      claimed: false,
      armed: false,
      distance: 0,
    };
  }

  function onTouchMove(event) {
    if (!gesture) return;
    if (event.touches.length !== 1 || !launchIsEligible()) {
      cancel();
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    if (!gesture.claimed) {
      if (deltaY < 0 || (Math.abs(deltaX) > PULL_CLAIM_THRESHOLD && !qualifiesPullGesture(deltaX, deltaY))) {
        cancel();
        return;
      }
      if (!qualifiesPullGesture(deltaX, deltaY)) return;
      gesture.claimed = true;
      indicator.hidden = false;
      indicator.classList.add("is-pulling");
      scroller.classList.add("is-pull-dragging");
    }

    event.preventDefault();
    gesture.distance = Math.min(124, Math.max(0, deltaY * 0.5));
    const progress = Math.min(1, gesture.distance / PULL_REFRESH_THRESHOLD);
    indicator.style.setProperty("--pull-distance", `${gesture.distance}px`);
    indicator.style.setProperty("--pull-progress", String(progress));
    for (let index = 0; index < 8; index += 1) {
      const revealProgress = Math.max(0, Math.min(1, (progress - index / 8) * 8));
      const spokeOpacity = revealProgress * PULL_SPOKE_OPACITIES[index];
      indicator.style.setProperty(`--spoke-${index + 1}`, String(spokeOpacity));
    }
    indicator.style.setProperty("--pull-angle", `${Math.min(324, gesture.distance / PULL_REFRESH_THRESHOLD * 324)}deg`);
    indicator.style.setProperty("--pull-rotation", `${gesture.distance * 2}deg`);
    scroller.style.setProperty("--pull-offset", `${gesture.distance}px`);
    if (!gesture.armed && gesture.distance >= PULL_REFRESH_THRESHOLD) {
      gesture.armed = true;
      indicator.classList.add("is-arming");
      window.clearTimeout(cycleTimer);
      cycleTimer = window.setTimeout(() => {
        cycleTimer = null;
        if (indicator.classList.contains("is-arming")) indicator.classList.add("is-cycling");
      }, PULL_CYCLE_START_MS);
      label.textContent = "Release to refresh";
    }
  }

  function onSpinnerAnimationEnd(event) {
    if (event.animationName !== "pull-refresh-arm" || !indicator.classList.contains("is-arming")) return;
    indicator.classList.remove("is-arming");
    indicator.classList.add("is-ready");
  }

  function onTouchEnd() {
    if (!gesture) return;
    const shouldRefresh = gesture.claimed && gesture.armed;
    gesture = null;
    if (shouldRefresh) void refresh();
    else resetIndicator();
  }

  async function refresh() {
    refreshing = true;
    scroller.classList.remove("is-pull-dragging");
    scroller.style.setProperty("--pull-offset", "56px");
    indicator.hidden = false;
    indicator.classList.remove("is-pulling", "is-arming", "is-cycling", "is-error");
    indicator.classList.add("is-ready", "is-refreshing");
    label.textContent = "Refreshing…";

    try {
      await hardRefresh();
    } catch (error) {
      console.warn("[MSSP] Pull-to-refresh failed.", error);
      refreshing = false;
      indicator.classList.remove("is-refreshing");
      indicator.classList.add("is-error");
      label.textContent = "Couldn’t refresh";
      resetTimer = window.setTimeout(resetIndicator, 1_600);
    }
  }

  function resetIndicator() {
    window.clearTimeout(resetTimer);
    window.clearTimeout(cycleTimer);
    resetTimer = null;
    cycleTimer = null;
    gesture = null;
    indicator.classList.remove("is-pulling", "is-arming", "is-cycling", "is-ready", "is-refreshing", "is-error");
    indicator.style.removeProperty("--pull-distance");
    indicator.style.removeProperty("--pull-progress");
    for (let index = 1; index <= 8; index += 1) {
      indicator.style.removeProperty(`--spoke-${index}`);
    }
    indicator.style.removeProperty("--pull-angle");
    indicator.style.removeProperty("--pull-rotation");
    scroller.classList.remove("is-pull-dragging");
    scroller.style.removeProperty("--pull-offset");
    indicator.hidden = true;
    label.textContent = "Pull to refresh";
  }

  function cancel() {
    if (refreshing) return;
    resetIndicator();
  }

  function destroy() {
    cancel();
    document.body.classList.remove("pwa-pull-enabled");
    document.removeEventListener("touchstart", onTouchStart, true);
    document.removeEventListener("touchmove", onTouchMove, true);
    document.removeEventListener("touchend", onTouchEnd, true);
    document.removeEventListener("touchcancel", cancel, true);
    spinner.removeEventListener("animationend", onSpinnerAnimationEnd);
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
  document.addEventListener("touchcancel", cancel, { passive: true, capture: true });
  spinner.addEventListener("animationend", onSpinnerAnimationEnd);

  return { cancel, destroy };
}

function normalizeLease(value) {
  if (value?.type !== "PWA_UPDATE_OWNER"
    || typeof value.ownerId !== "string"
    || !Number.isFinite(value.priority)
    || !Number.isFinite(value.startedAt)
    || !Number.isFinite(value.expiresAt)) return null;
  return value;
}

function createOwnerId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
