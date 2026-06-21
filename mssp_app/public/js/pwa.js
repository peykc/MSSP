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
