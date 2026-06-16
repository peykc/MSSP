const HEAT_STOPS = [
  { t: 0, color: [54, 69, 79] },
  { t: 0.25, color: [47, 111, 106] },
  { t: 0.5, color: [104, 165, 92] },
  { t: 0.72, color: [216, 162, 60] },
  { t: 1, color: [226, 81, 47] },
];

const COLLECTIONS = [
  { kind: "old", label: "Old Testament" },
  { kind: "new", label: "New Testament" },
  { kind: "paytch", label: "PAYTCH" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function emptySpread() {
  return { old: 0, new: 0, paytch: 0 };
}

function getWeekday(date) {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time)) return -1;
  return new Date(time).getUTCDay();
}

function heatColor(value) {
  const clamped = Math.max(0, Math.min(1, value));
  for (let index = 1; index < HEAT_STOPS.length; index += 1) {
    const previous = HEAT_STOPS[index - 1];
    const next = HEAT_STOPS[index];
    if (clamped <= next.t) {
      const span = next.t - previous.t || 1;
      const ratio = (clamped - previous.t) / span;
      const channels = previous.color.map((channel, channelIndex) =>
        Math.round(channel + (next.color[channelIndex] - channel) * ratio),
      );
      return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
    }
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1].color;
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

const COLOR_GRADIENT = "linear-gradient(90deg, rgb(54, 69, 79) 0%, rgb(47, 111, 106) 25%, rgb(104, 165, 92) 50%, rgb(216, 162, 60) 72%, rgb(226, 81, 47) 100%)";
const BRIGHTNESS_GRADIENT = "linear-gradient(90deg, hsl(28, 85%, 16%) 0%, hsl(28, 88%, 62%) 100%)";

function brightnessColor(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const lightness = 16 + (clamped * 46);
  return `hsl(28, 86%, ${lightness.toFixed(1)}%)`;
}

export function createCalendarModal({ dom }) {
  let restoreFocusTo = null;
  let isOpen = false;
  let coverByKind = {};
  let pinnedCell = null;
  let heatmapMode = "color";
  let currentEpisodes = [];

  const modeButtons = [...dom.calendarModal.querySelectorAll(".calendar-mode__btn")];
  const legendScale = dom.calendarModal.querySelector(".calendar-legend__scale");

  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }

  function setMode(mode) {
    if (mode === heatmapMode) return;
    heatmapMode = mode;
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    renderHeatmap(currentEpisodes);
  }

  function colorForIntensity(value) {
    return heatmapMode === "brightness" ? brightnessColor(value) : heatColor(value);
  }

  const tooltip = document.createElement("div");
  tooltip.className = "calendar-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  dom.calendarModal.appendChild(tooltip);

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let closeTransitionEnd = null;
  let closeFallbackTimer = null;

  function open(episodes, trigger) {
    restoreFocusTo = trigger;
    currentEpisodes = episodes;
    renderHeatmap(episodes);
    if (closeTransitionEnd) {
      dom.calendarModal.removeEventListener("transitionend", closeTransitionEnd);
      closeTransitionEnd = null;
    }
    if (closeFallbackTimer !== null) {
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    }
    dom.calendarModal.classList.remove("is-leaving");
    dom.calendarModal.hidden = false;
    dom.calendarModal.setAttribute("aria-hidden", "false");
    dom.app.inert = true;
    document.body.classList.add("calendar-open");
    isOpen = true;

    if (!prefersReducedMotion()) {
      dom.calendarModal.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dom.calendarModal.classList.remove("is-entering"));
      });
    }

    requestAnimationFrame(() => dom.calendarClose.focus());
  }

  function finishClose() {
    dom.calendarModal.classList.remove("is-leaving");
    dom.calendarModal.hidden = true;
    dom.calendarModal.setAttribute("aria-hidden", "true");
    dom.app.inert = false;
    document.body.classList.remove("calendar-open");
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected
        ? restoreFocusTo
        : dom.launchHero.querySelector('[data-hero-action="heatmap"]');
      target?.focus();
      restoreFocusTo = null;
    });
  }

  function close() {
    if (!isOpen) return;
    pinnedCell = null;
    hideTooltip();
    isOpen = false;

    if (prefersReducedMotion()) {
      finishClose();
      return;
    }

    dom.calendarModal.classList.add("is-leaving");
    closeTransitionEnd = (event) => {
      if (event.target !== dom.calendarDialog || event.propertyName !== "transform") return;
      dom.calendarModal.removeEventListener("transitionend", closeTransitionEnd);
      closeTransitionEnd = null;
      if (closeFallbackTimer !== null) {
        clearTimeout(closeFallbackTimer);
        closeFallbackTimer = null;
      }
      finishClose();
    };
    dom.calendarModal.addEventListener("transitionend", closeTransitionEnd);
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null;
      if (closeTransitionEnd) {
        dom.calendarModal.removeEventListener("transitionend", closeTransitionEnd);
        closeTransitionEnd = null;
      }
      finishClose();
    }, 460);
  }

  function renderHeatmap(episodes) {
    coverByKind = {};
    pinnedCell = null;
    hideTooltip();

    const dayCounts = Array.from({ length: 31 }, () => 0);
    const dayBreakdown = Array.from({ length: 31 }, emptySpread);
    const weekdayCounts = Array.from({ length: 7 }, () => 0);
    const weekdayBreakdown = Array.from({ length: 7 }, emptySpread);
    const monthCounts = Array.from({ length: 12 }, () => 0);
    const monthBreakdown = Array.from({ length: 12 }, emptySpread);

    for (const episode of episodes) {
      const kind = episode.collectionKind;
      if (kind && !coverByKind[kind] && episode.coverUrl) coverByKind[kind] = episode.coverUrl;

      const day = Number(String(episode.date || "").slice(8, 10));
      if (day >= 1 && day <= 31) {
        dayCounts[day - 1] += 1;
        if (kind && dayBreakdown[day - 1][kind] !== undefined) dayBreakdown[day - 1][kind] += 1;
      }

      const month = Number(String(episode.date || "").slice(5, 7));
      if (month >= 1 && month <= 12) {
        monthCounts[month - 1] += 1;
        if (kind && monthBreakdown[month - 1][kind] !== undefined) monthBreakdown[month - 1][kind] += 1;
      }

      const weekday = getWeekday(episode.date);
      if (weekday >= 0) {
        weekdayCounts[weekday] += 1;
        if (kind && weekdayBreakdown[weekday][kind] !== undefined) weekdayBreakdown[weekday][kind] += 1;
      }
    }

    renderWeekdayRow(weekdayCounts, weekdayBreakdown);
    renderMonthRow(monthCounts, monthBreakdown);
    renderMonthGrid(dayCounts, dayBreakdown);

    if (legendScale) {
      legendScale.style.background = heatmapMode === "brightness" ? BRIGHTNESS_GRADIENT : COLOR_GRADIENT;
    }
  }

  function renderWeekdayRow(counts, breakdown) {
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const range = max - min || 1;
    dom.calendarWeekdays.innerHTML = counts.map((count, index) => {
      const intensity = (count - min) / range;
      const name = WEEKDAYS[index];
      const label = `${name}, ${count} episodes. Old Testament ${breakdown[index].old}, New Testament ${breakdown[index].new}, PAYTCH ${breakdown[index].paytch}`;
      return `
        <button type="button" class="calendar-day" aria-label="${label}" style="--day-color: ${colorForIntensity(intensity)}">
          <strong class="calendar-day__num">${name}</strong>
          <span class="calendar-day__count">${count}</span>
        </button>
      `;
    }).join("");

    const cells = [...dom.calendarWeekdays.querySelectorAll(".calendar-day")];
    cells.forEach((cell, index) => bindCell(cell, `${WEEKDAYS[index]}s`, breakdown[index]));
  }

  function renderMonthRow(counts, breakdown) {
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const range = max - min || 1;
    dom.calendarMonths.innerHTML = counts.map((count, index) => {
      const intensity = (count - min) / range;
      const name = MONTHS[index];
      const label = `${name}, ${count} episodes. Old Testament ${breakdown[index].old}, New Testament ${breakdown[index].new}, PAYTCH ${breakdown[index].paytch}`;
      return `
        <button type="button" class="calendar-day" aria-label="${label}" style="--day-color: ${colorForIntensity(intensity)}">
          <strong class="calendar-day__num">${name}</strong>
          <span class="calendar-day__count">${count}</span>
        </button>
      `;
    }).join("");

    const cells = [...dom.calendarMonths.querySelectorAll(".calendar-day")];
    cells.forEach((cell, index) => bindCell(cell, MONTHS[index], breakdown[index]));
  }

  function renderMonthGrid(counts, breakdown) {
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const range = max - min || 1;
    const cellsMarkup = counts.map((count, index) => {
      const day = index + 1;
      const intensity = (count - min) / range;
      const spread = breakdown[index];
      const label = `Day ${day}, ${count} episodes. Old Testament ${spread.old}, New Testament ${spread.new}, PAYTCH ${spread.paytch}`;
      return `
        <button type="button" class="calendar-day" data-day="${day}" aria-label="${label}" style="--day-color: ${colorForIntensity(intensity)}">
          <strong class="calendar-day__num">${day}</strong>
          <span class="calendar-day__count">${count}</span>
        </button>
      `;
    });
    const trailingBlanks = (7 - (counts.length % 7)) % 7;
    for (let index = 0; index < trailingBlanks; index += 1) {
      cellsMarkup.push('<div class="calendar-day calendar-day--empty" aria-hidden="true"></div>');
    }
    dom.calendarHeatmap.innerHTML = cellsMarkup.join("");

    const cells = [...dom.calendarHeatmap.querySelectorAll(".calendar-day[data-day]")];
    cells.forEach((cell, index) => bindCell(cell, `Day ${index + 1}`, breakdown[index]));
  }

  function bindCell(cell, title, spread) {
    cell.tooltipData = { title, spread };
    cell.addEventListener("mouseenter", () => {
      if (!pinnedCell) showTooltip(cell);
    });
    cell.addEventListener("mouseleave", () => {
      if (!pinnedCell) hideTooltip();
    });
    cell.addEventListener("focus", () => showTooltip(cell));
    cell.addEventListener("blur", () => {
      if (!pinnedCell) hideTooltip();
    });
    cell.addEventListener("click", () => {
      if (pinnedCell === cell) {
        pinnedCell = null;
        hideTooltip();
      } else {
        pinnedCell = cell;
        showTooltip(cell);
      }
    });
  }

  function showTooltip(cell) {
    const data = cell.tooltipData;
    if (!data) return;
    const { title, spread } = data;
    tooltip.innerHTML = `
      <div class="calendar-tooltip__title">${title}</div>
      <div class="calendar-tooltip__items">
        ${COLLECTIONS.map(({ kind, label }) => `
          <div class="calendar-tooltip__item${spread[kind] === 0 ? " is-empty" : ""}">
            <img src="${coverByKind[kind] || ""}" alt="${label}" loading="lazy">
            <span class="calendar-tooltip__count">${spread[kind]}</span>
          </div>
        `).join("")}
      </div>
    `;
    tooltip.hidden = false;
    positionTooltip(cell);
  }

  function positionTooltip(cell) {
    const rect = cell.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const margin = 10;
    const center = rect.left + (rect.width / 2);
    const clampedLeft = Math.min(
      Math.max(center, (tipRect.width / 2) + margin),
      window.innerWidth - (tipRect.width / 2) - margin,
    );
    const fitsAbove = rect.top - tipRect.height - margin > margin;
    tooltip.dataset.placement = fitsAbove ? "top" : "bottom";
    tooltip.style.left = `${clampedLeft}px`;
    tooltip.style.top = `${fitsAbove ? rect.top - margin : rect.bottom + margin}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
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
    if (event.target === dom.calendarModal) {
      close();
      return;
    }
    if (!event.target.closest(".calendar-day")) {
      pinnedCell = null;
      hideTooltip();
    }
  });
  dom.calendarDialog.addEventListener("scroll", () => {
    pinnedCell = null;
    hideTooltip();
  });
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
  };
}
