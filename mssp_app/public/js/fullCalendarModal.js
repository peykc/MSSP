const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const COLLECTION_META = {
  old: { label: "Old", accent: "#8da1b8" },
  new: { label: "New", accent: "#c79457" },
  paytch: { label: "PAYTCH", accent: "#db855f" },
};
const COLLECTION_ORDER = ["old", "new", "paytch"];

const CANCELLED_DATE = "2019-09-16";

const SEVEN_SEGMENTS = ["a", "b", "c", "d", "e", "f", "g"];
const SEGMENT_MAP = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  P: "abefg",
};

function renderSevenSegmentFromActive(active) {
  const segments = SEVEN_SEGMENTS.map(
    (segment) => `<span class="seg seg--${segment}${active.includes(segment) ? " is-on" : ""}"></span>`,
  ).join("");
  return `<span class="seg-digit" aria-hidden="true">${segments}</span>`;
}

function renderSevenSegmentDigit(char) {
  return renderSevenSegmentFromActive(SEGMENT_MAP[char] || "");
}

function renderSegmentColon() {
  return '<span class="seg-colon" aria-hidden="true"><i></i><i></i></span>';
}

function renderCancelledTimeM() {
  return `<span class="fc-tip__time-m">${renderSevenSegmentFromActive("abcef")}${renderSevenSegmentFromActive("abc")}</span>`;
}

function renderCancelledTimeDisplay() {
  return [
    renderSevenSegmentDigit("2"),
    renderSegmentColon(),
    renderSevenSegmentDigit("1"),
    renderSevenSegmentDigit("5"),
    '<span class="fc-tip__time-gap" aria-hidden="true"></span>',
    renderSevenSegmentDigit("P"),
    renderCancelledTimeM(),
  ].join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseDateParts(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

export function createFullCalendarModal({ dom }) {
  let restoreFocusTo = null;
  let isOpen = false;
  let pinnedCell = null;
  let hoverCell = null;
  let episodesByDate = new Map();
  let renderedEpisodes = null;
  let viewportAnchor = null;
  let activeResizeAnchor = null;
  let anchorFrame = null;
  let resizeFrame = null;
  let resizeEndTimer = null;
  let spotlightCell = null;
  let suppressScrollDismiss = false;

  const tooltip = document.createElement("div");
  tooltip.className = "full-calendar-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  dom.fullCalendarModal.appendChild(tooltip);

  renderLegend();
  renderWeekdayHeader();
  bindDelegatedEvents();

  function renderLegend() {
    dom.fullCalendarLegend.innerHTML = COLLECTION_ORDER.map((kind) => {
      const meta = COLLECTION_META[kind];
      return `
        <span class="full-calendar__legend-item">
          <span class="full-calendar__dot" style="--dot-color: ${meta.accent}"></span>
          ${escapeHtml(meta.label)}
        </span>
      `;
    }).join("");
  }

  function renderWeekdayHeader() {
    dom.fullCalendarWeekdays.innerHTML = WEEKDAY_INITIALS.map((initial, index) =>
      `<span class="full-calendar__weekday" title="${WEEKDAY_NAMES[index]}">${initial}</span>`,
    ).join("");
  }

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let closeTransitionEnd = null;
  let closeFallbackTimer = null;

  function clearPendingClose() {
    if (closeTransitionEnd) {
      dom.fullCalendarModal.removeEventListener("transitionend", closeTransitionEnd);
      closeTransitionEnd = null;
    }
    if (closeFallbackTimer !== null) {
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    }
  }

  function open(episodes, trigger, { focusDate } = {}) {
    restoreFocusTo = trigger;
    render(episodes);
    clearPendingClose();
    dom.fullCalendarModal.classList.remove("is-leaving");
    dom.fullCalendarModal.hidden = false;
    dom.fullCalendarModal.setAttribute("aria-hidden", "false");
    dom.app.inert = true;
    document.body.classList.add("calendar-open");
    isOpen = true;

    if (!prefersReducedMotion()) {
      dom.fullCalendarModal.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dom.fullCalendarModal.classList.remove("is-entering"));
      });
    }

    requestAnimationFrame(() => {
      if (focusDate) {
        requestAnimationFrame(() => {
          scrollToDate(focusDate);
          dom.fullCalendarClose.focus();
          requestAnimationFrame(() => {
            viewportAnchor = captureViewportAnchor();
          });
        });
        return;
      }

      dom.fullCalendarClose.focus();
      dom.fullCalendarBody.scrollLeft = 0;
      dom.fullCalendarBody.scrollTop = dom.fullCalendarBody.scrollHeight;
      requestAnimationFrame(() => {
        viewportAnchor = captureViewportAnchor();
      });
    });
  }

  function finishClose() {
    dom.fullCalendarModal.classList.remove("is-leaving");
    dom.fullCalendarModal.hidden = true;
    dom.fullCalendarModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("calendar-open");
    dom.app.inert = document.body.classList.contains("player-expanded");
    if (document.body.classList.contains("player-expanded")) {
      restoreFocusTo = null;
      return;
    }
    requestAnimationFrame(() => {
      const target = restoreFocusTo?.isConnected
        ? restoreFocusTo
        : dom.launchHero.querySelector('[data-hero-action="calendar"]');
      if (target?.matches("[data-open-cancelled-calendar]")) {
        target.blur();
      } else {
        target?.focus();
      }
      restoreFocusTo = null;
    });
  }

  function close() {
    if (!isOpen) return;
    clearSpotlight();
    pinnedCell = null;
    hoverCell = null;
    hideTooltip();
    isOpen = false;
    viewportAnchor = null;
    activeResizeAnchor = null;
    if (anchorFrame !== null) cancelAnimationFrame(anchorFrame);
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (resizeEndTimer !== null) clearTimeout(resizeEndTimer);
    anchorFrame = null;
    resizeFrame = null;
    resizeEndTimer = null;

    if (prefersReducedMotion()) {
      finishClose();
      return;
    }

    dom.fullCalendarModal.classList.add("is-leaving");
    closeTransitionEnd = (event) => {
      if (event.target !== dom.fullCalendarDialog || event.propertyName !== "transform") return;
      clearPendingClose();
      finishClose();
    };
    dom.fullCalendarModal.addEventListener("transitionend", closeTransitionEnd);
    closeFallbackTimer = setTimeout(() => {
      clearPendingClose();
      finishClose();
    }, 420);
  }

  function render(episodes) {
    pinnedCell = null;
    hoverCell = null;
    clearSpotlight();
    hideTooltip();

    if (episodes === renderedEpisodes) return;
    renderedEpisodes = episodes;
    episodesByDate = new Map();

    let min = null;
    let max = null;
    for (const episode of episodes) {
      const parts = parseDateParts(episode.date);
      if (!parts) continue;
      const key = episode.date;
      if (!episodesByDate.has(key)) episodesByDate.set(key, []);
      episodesByDate.get(key).push(episode);
      const ordinal = parts.year * 12 + parts.month;
      if (min === null || ordinal < min) min = ordinal;
      if (max === null || ordinal > max) max = ordinal;
    }

    if (min === null || max === null) {
      dom.fullCalendarMonths.innerHTML = '<p class="full-calendar__empty">No release dates available.</p>';
      return;
    }

    const months = [];
    for (let ordinal = min; ordinal <= max; ordinal += 1) {
      months.push(renderMonth(Math.floor(ordinal / 12), ordinal % 12));
    }
    dom.fullCalendarMonths.innerHTML = months.join("");
  }

  function renderMonth(year, month) {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    const cells = [];
    for (let blank = 0; blank < firstWeekday; blank += 1) {
      cells.push('<span class="cal-cell cal-cell--blank" aria-hidden="true"></span>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayEpisodes = episodesByDate.get(dateKey);
      if (dateKey === CANCELLED_DATE) {
        cells.push(`
          <button type="button" class="cal-cell cal-cell--event cal-cell--cancelled" data-date="${dateKey}" data-cancelled="true" aria-label="September 16, 2019: the day he got cancelled">
            <span class="cal-cell__num">${day}</span>
            <span class="cal-cell__cancel-mark" aria-hidden="true">!</span>
          </button>
        `);
      } else if (dayEpisodes && dayEpisodes.length) {
        const kinds = COLLECTION_ORDER.filter((kind) =>
          dayEpisodes.some((episode) => episode.collectionKind === kind),
        );
        const label = `${MONTH_NAMES[month]} ${day}, ${year}: ${dayEpisodes.length} ${dayEpisodes.length === 1 ? "release" : "releases"}`;

        let variantClass;
        let styleVars;
        let dots;
        if (kinds.length >= 2) {
          const topLeftKind = kinds.find((kind) => kind !== "paytch") || kinds[0];
          const bottomRightKind = kinds.includes("paytch")
            ? "paytch"
            : kinds.find((kind) => kind !== topLeftKind) || kinds[1];
          const topLeftAccent = COLLECTION_META[topLeftKind].accent;
          const bottomRightAccent = COLLECTION_META[bottomRightKind].accent;
          variantClass = "cal-cell--split";
          styleVars = `--accent-a: ${topLeftAccent}; --accent-b: ${bottomRightAccent}`;
          dots =
            `<span class="cal-cell__dot cal-cell__dot--tl" style="--dot-color: ${topLeftAccent}"></span>` +
            `<span class="cal-cell__dot cal-cell__dot--br" style="--dot-color: ${bottomRightAccent}"></span>`;
        } else {
          const accent = COLLECTION_META[kinds[0]]?.accent || "#888";
          variantClass = "cal-cell--single";
          styleVars = `--cell-accent: ${accent}`;
          dots = `<span class="cal-cell__dot cal-cell__dot--center" style="--dot-color: ${accent}"></span>`;
        }

        cells.push(`
          <button type="button" class="cal-cell cal-cell--event cal-cell--release ${variantClass}" data-date="${dateKey}" style="${styleVars}" aria-label="${escapeHtml(label)}">
            <span class="cal-cell__num">${day}</span>
            ${dots}
          </button>
        `);
      } else {
        cells.push(`<span class="cal-cell" data-date="${dateKey}"><span class="cal-cell__num">${day}</span></span>`);
      }
    }

    const rows = Math.ceil((firstWeekday + daysInMonth) / 7);
    return `
      <section class="cal-month" data-rows="${rows}">
        <h3 class="cal-month__title">
          <span class="cal-month__name">${MONTH_NAMES[month]}</span>
          <span class="cal-month__year">${year}</span>
        </h3>
        <div class="cal-month__grid">${cells.join("")}</div>
      </section>
    `;
  }

  function captureViewportAnchor() {
    const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
    if (bodyRect.width <= 0 || bodyRect.height <= 0) return viewportAnchor;

    const weekdayRect = dom.fullCalendarWeekdays.getBoundingClientRect();
    const stickyOffset = Math.max(0, weekdayRect.bottom - bodyRect.top);
    const anchorY = Math.min(
      bodyRect.bottom - 1,
      bodyRect.top + stickyOffset + Math.max(36, Math.min(90, bodyRect.height * 0.18)),
    );
    const sampleXs = [
      bodyRect.left + (bodyRect.width * 0.5),
      bodyRect.left + (bodyRect.width * 0.25),
      bodyRect.left + (bodyRect.width * 0.75),
    ];

    for (const x of sampleXs) {
      const cell = document.elementFromPoint(x, anchorY)?.closest(".cal-cell[data-date]");
      if (cell && dom.fullCalendarBody.contains(cell)) return anchorFromCell(cell, bodyRect);
    }

    let bestCell = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cell of dom.fullCalendarMonths.querySelectorAll(".cal-cell[data-date]")) {
      const rect = cell.getBoundingClientRect();
      const isVisible = rect.bottom > bodyRect.top + stickyOffset && rect.top < bodyRect.bottom;
      if (!isVisible) continue;
      const distance = Math.abs(rect.top - anchorY) + Math.abs((rect.left + rect.width / 2) - sampleXs[0]) * 0.15;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCell = cell;
      }
    }

    return bestCell ? anchorFromCell(bestCell, bodyRect) : viewportAnchor;
  }

  function anchorFromCell(cell, bodyRect) {
    const rect = cell.getBoundingClientRect();
    return {
      date: cell.dataset.date,
      offset: rect.top - bodyRect.top,
    };
  }

  function restoreViewportAnchor(anchor) {
    if (!anchor?.date) return;
    const cell = dom.fullCalendarMonths.querySelector(`.cal-cell[data-date="${anchor.date}"]`);
    if (!cell) return;

    const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    dom.fullCalendarBody.scrollLeft = 0;
    dom.fullCalendarBody.scrollTop += rect.top - bodyRect.top - anchor.offset;
  }

  function scrollToDate(dateKey) {
    const cell = dom.fullCalendarMonths.querySelector(`.cal-cell[data-date="${dateKey}"]`);
    if (!cell) return null;

    const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
    const weekdayRect = dom.fullCalendarWeekdays.getBoundingClientRect();
    const stickyOffset = Math.max(0, weekdayRect.bottom - bodyRect.top);
    const cellRect = cell.getBoundingClientRect();
    const visibleHeight = bodyRect.height - stickyOffset;
    const targetScroll = dom.fullCalendarBody.scrollTop
      + cellRect.top
      - bodyRect.top
      - stickyOffset
      - (visibleHeight / 2)
      + (cellRect.height / 2);

    dom.fullCalendarBody.scrollLeft = 0;
    suppressScrollDismiss = true;
    dom.fullCalendarBody.scrollTop = Math.max(0, targetScroll);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressScrollDismiss = false;
      });
    });
    return cell;
  }

  function clearSpotlight() {
    if (!spotlightCell) return;
    spotlightCell.classList.remove("cal-cell--spotlight");
    spotlightCell = null;
  }

  function spotlightDate(dateKey) {
    clearSpotlight();
    const cell = scrollToDate(dateKey);
    if (!cell) return null;

    cell.classList.add("cal-cell--spotlight");
    spotlightCell = cell;

    if (cell.classList.contains("cal-cell--event")) {
      pinnedCell = cell;
      showTooltip(cell);
    }

    return cell;
  }

  function scheduleAnchorCapture() {
    if (activeResizeAnchor || anchorFrame !== null) return;
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = null;
      viewportAnchor = captureViewportAnchor();
    });
  }

  function handleResize() {
    if (!isOpen) return;
    pinnedCell = null;
    hoverCell = null;
    hideTooltip();

    activeResizeAnchor ||= viewportAnchor || captureViewportAnchor();
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      restoreViewportAnchor(activeResizeAnchor);
    });

    if (resizeEndTimer !== null) clearTimeout(resizeEndTimer);
    resizeEndTimer = setTimeout(() => {
      resizeEndTimer = null;
      restoreViewportAnchor(activeResizeAnchor);
      viewportAnchor = captureViewportAnchor();
      activeResizeAnchor = null;
    }, 140);
  }

  function bindDelegatedEvents() {
    dom.fullCalendarMonths.addEventListener("mouseover", (event) => {
      const cell = event.target.closest(".cal-cell--event");
      if (cell === hoverCell) return;
      hoverCell = cell;
      if (pinnedCell) return;
      if (cell) showTooltip(cell);
      else hideTooltip();
    });
    dom.fullCalendarMonths.addEventListener("mouseleave", () => {
      hoverCell = null;
      if (!pinnedCell) hideTooltip();
    });
    dom.fullCalendarMonths.addEventListener("focusin", (event) => {
      const cell = event.target.closest(".cal-cell--event");
      if (cell) showTooltip(cell);
    });
    dom.fullCalendarMonths.addEventListener("focusout", (event) => {
      const cell = event.target.closest(".cal-cell--event");
      if (cell && cell !== pinnedCell) hideTooltip();
    });
    dom.fullCalendarMonths.addEventListener("click", (event) => {
      const cell = event.target.closest(".cal-cell--event");
      if (!cell) return;
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
    if (cell.dataset.cancelled) {
      showCancelledTooltip(cell);
      return;
    }

    const dateKey = cell.dataset.date;
    const dayEpisodes = episodesByDate.get(dateKey);
    if (!dayEpisodes || !dayEpisodes.length) return;

    tooltip.classList.remove("full-calendar-tooltip--cancelled");
    const parts = parseDateParts(dateKey);
    const heading = parts ? `${MONTH_NAMES[parts.month]} ${parts.day}, ${parts.year}` : dateKey;
    const items = dayEpisodes.map((episode) => {
      const meta = COLLECTION_META[episode.collectionKind] || { label: "", accent: "#888" };
      const epLabel = episode.episode ? `${meta.label} · Ep ${escapeHtml(episode.episode)}` : meta.label;
      return `
        <li class="fc-tip__item">
          <img class="fc-tip__cover" src="${escapeHtml(episode.coverUrl || "")}" alt="" loading="lazy">
          <span class="fc-tip__text">
            <span class="fc-tip__ep" style="--ep-color: ${meta.accent}">${escapeHtml(epLabel)}</span>
            <span class="fc-tip__name">${escapeHtml(episode.title || "Untitled")}</span>
          </span>
        </li>
      `;
    }).join("");

    tooltip.innerHTML = `
      <div class="fc-tip__title">${escapeHtml(heading)}</div>
      <ul class="fc-tip__list">${items}</ul>
    `;
    tooltip.hidden = false;
    positionTooltip(cell);
  }

  function showCancelledTooltip(cell) {
    tooltip.classList.add("full-calendar-tooltip--cancelled");
    tooltip.innerHTML = `
      <div class="fc-tip__hazard">Cancelled</div>
      <div class="fc-tip__cancel">
        <strong>September 16, 2019</strong>
        <div class="fc-tip__time-block">
          <div class="fc-tip__time-display" role="img" aria-label="2:15 PM Eastern Time">
            ${renderCancelledTimeDisplay()}
          </div>
          <span class="fc-tip__time-sub">Eastern Time</span>
        </div>
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

    const focusable = [...dom.fullCalendarDialog.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")];
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

  dom.fullCalendarClose.addEventListener("click", close);
  dom.fullCalendarModal.addEventListener("click", (event) => {
    if (event.target === dom.fullCalendarModal) {
      close();
      return;
    }
    if (!event.target.closest(".cal-cell--event")) {
      pinnedCell = null;
      hideTooltip();
    }
  });
  dom.fullCalendarBody.addEventListener("scroll", () => {
    if (!suppressScrollDismiss && (pinnedCell || hoverCell !== null)) {
      pinnedCell = null;
      hoverCell = null;
      hideTooltip();
    }
    scheduleAnchorCapture();
  }, { passive: true });
  window.addEventListener("resize", handleResize);
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
  };
}
