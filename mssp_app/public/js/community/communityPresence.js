export function createCommunityPresence({
  communitySignals,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  heartbeatIntervalMs = 45_000,
} = {}) {
  let started = false;
  let listeningActive = false;
  let desiredOnline = false;
  let activeOnline = false;
  let heartbeatTimer = null;
  let transition = Promise.resolve();

  const setIntervalFn = windowRef?.setInterval?.bind(windowRef) || globalThis.setInterval;
  const clearIntervalFn = windowRef?.clearInterval?.bind(windowRef) || globalThis.clearInterval;

  function start() {
    if (started) return;
    started = true;
    documentRef?.addEventListener?.("visibilitychange", handleVisibilityChange);
    windowRef?.addEventListener?.("online", handleOnline);
    windowRef?.addEventListener?.("beforeunload", handleBeforeUnload);
    reconcilePresence();
  }

  function stop() {
    if (!started) return;
    started = false;
    documentRef?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    windowRef?.removeEventListener?.("online", handleOnline);
    windowRef?.removeEventListener?.("beforeunload", handleBeforeUnload);
    clearHeartbeatTimer();
    if (activeOnline) {
      void communitySignals.sendOnlineHeartbeat({ online: false, keepalive: true });
      activeOnline = false;
    }
    desiredOnline = false;
    listeningActive = false;
  }

  function setListeningActive(next) {
    const listening = Boolean(next);
    if (listeningActive === listening) return;
    listeningActive = listening;
    reconcilePresence();
  }

  function handleVisibilityChange() {
    reconcilePresence();
  }

  function handleOnline() {
    if (desiredOnline) {
      void communitySignals.sendOnlineHeartbeat({ online: true });
    }
  }

  function handleBeforeUnload() {
    if (!activeOnline) return;
    void communitySignals.sendOnlineHeartbeat({ online: false, keepalive: true });
  }

  function reconcilePresence() {
    desiredOnline = documentRef?.visibilityState === "visible" || listeningActive;
    queueReconcile();
  }

  function queueReconcile() {
    transition = transition.then(reconcile).catch(() => {});
  }

  async function reconcile() {
    if (!started || desiredOnline === activeOnline) return;
    clearHeartbeatTimer();
    if (activeOnline) {
      await communitySignals.sendOnlineHeartbeat({ online: false });
      activeOnline = false;
    }
    if (!started || !desiredOnline) return;
    activeOnline = true;
    await communitySignals.sendOnlineHeartbeat({ online: true });
    if (!started || !activeOnline) return;
    heartbeatTimer = setIntervalFn(() => {
      if (!activeOnline) return;
      void communitySignals.sendOnlineHeartbeat({ online: true });
    }, heartbeatIntervalMs);
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  return { start, stop, setListeningActive };
}
