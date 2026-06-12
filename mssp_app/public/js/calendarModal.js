export function createCalendarModal({ dom }) {
  let restoreFocusTo = null;
  let isOpen = false;

  function open(episodes, trigger) {
    restoreFocusTo = trigger;
    renderHeatmap(episodes);
    dom.calendarModal.hidden = false;
    dom.calendarModal.setAttribute("aria-hidden", "false");
    dom.app.inert = true;
    dom.miniPlayer.inert = true;
    document.body.classList.add("calendar-open");
    isOpen = true;
    requestAnimationFrame(() => dom.calendarClose.focus());
  }

  function close() {
    if (!isOpen) return;
    dom.calendarModal.hidden = true;
    dom.calendarModal.setAttribute("aria-hidden", "true");
    dom.app.inert = false;
    dom.miniPlayer.inert = false;
    document.body.classList.remove("calendar-open");
    isOpen = false;
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected
        ? restoreFocusTo
        : dom.launchHero.querySelector('[data-hero-action="calendar"]');
      target?.focus();
      restoreFocusTo = null;
    });
  }

  function renderHeatmap(episodes) {
    const counts = Array.from({ length: 31 }, () => 0);
    for (const episode of episodes) {
      const day = Number(String(episode.date || "").slice(8, 10));
      if (day >= 1 && day <= 31) counts[day - 1] += 1;
    }
    const maxCount = Math.max(...counts, 1);
    dom.calendarHeatmap.innerHTML = counts.map((count, index) => {
      const day = index + 1;
      return `
        <div class="calendar-day" role="img" aria-label="Day ${day}, ${count} episodes" style="--day-alpha: ${0.08 + ((count / maxCount) * 0.78)}; --day-border-alpha: ${0.08 + ((count / maxCount) * 0.22)}">
          <strong>${day}</strong>
          <span>${count}</span>
        </div>
      `;
    }).join("");
  }

  function handleKeydown(event) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...dom.calendarDialog.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")];
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

  dom.calendarClose.addEventListener("click", close);
  dom.calendarModal.addEventListener("click", (event) => {
    if (event.target === dom.calendarModal) close();
  });
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
  };
}
