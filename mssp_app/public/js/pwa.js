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

let waitingWorker = null;
let reloadOnControllerChange = false;

function showUpdateBar(bar) {
  bar.hidden = false;
  document.body.classList.add("pwa-update-visible");
}

function trackWaitingWorker(worker, bar) {
  if (!worker) return;
  waitingWorker = worker;
  showUpdateBar(bar);
}

function handleInstallingWorker(worker, bar) {
  worker.addEventListener("statechange", () => {
    if (worker.state !== "installed") return;
    if (!navigator.serviceWorker.controller) return;
    trackWaitingWorker(worker, bar);
  });
}

function checkForWaitingWorker(registration, bar) {
  if (registration.waiting) {
    trackWaitingWorker(registration.waiting, bar);
    return;
  }

  if (registration.installing) {
    handleInstallingWorker(registration.installing, bar);
  }
}

function pollForUpdates(registration) {
  registration.update().catch(() => {});
}

export function initPwaUpdates(registration) {
  const bar = document.getElementById("pwaUpdateBar");
  const refreshButton = document.getElementById("pwaUpdateRefresh");
  if (!bar || !refreshButton) return;

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (worker) handleInstallingWorker(worker, bar);
  });

  checkForWaitingWorker(registration, bar);
  pollForUpdates(registration);

  window.addEventListener("focus", () => pollForUpdates(registration));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollForUpdates(registration);
  });

  refreshButton.addEventListener("click", () => {
    const worker = waitingWorker || registration.waiting;
    if (!worker) return;

    refreshButton.disabled = true;
    refreshButton.textContent = "Updating…";

    reloadOnControllerChange = true;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloadOnControllerChange) return;
      reloadOnControllerChange = false;
      location.reload();
    });

    worker.postMessage({ type: "SKIP_WAITING" });
  });
}
