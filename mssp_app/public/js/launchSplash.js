const SPLASH_FADE_MS = 420;

export function dismissLaunchSplash() {
  const splash = document.getElementById("launchSplash");
  document.body.classList.remove("launch-loading");
  if (!splash || splash.dataset.dismissed === "true") return;
  splash.dataset.dismissed = "true";

  const remove = () => {
    splash.classList.add("is-removed");
    splash.setAttribute("aria-hidden", "true");
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    splash.classList.add("is-hidden");
    remove();
    return;
  }

  splash.classList.add("is-hidden");
  splash.addEventListener("transitionend", (event) => {
    if (event.target !== splash || event.propertyName !== "opacity") return;
    remove();
  }, { once: true });
  window.setTimeout(remove, SPLASH_FADE_MS + 80);
}
