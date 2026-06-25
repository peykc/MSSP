import { renderCalCellGlyph, renderCollectionGlyphSvg } from "./collectionGlyphs.js";

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
const COLLECTION_ORDER = ["old", "paytch", "new"];

const CANCELLED_DATE = "2019-09-16";
const MONTH_GAP = 28;
const MONTH_OVERSCAN = 2;
const MONTHS_PADDING_TOP = 14;
const PROBE_ROW_COUNTS = [4, 5, 6];

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

function dateOrdinal(dateKey) {
  const parts = parseDateParts(dateKey);
  if (!parts) return null;
  return parts.year * 12 + parts.month;
}

export function createFullCalendarModal({ dom }) {
  let restoreFocusTo = null;
  let isOpen = false;
  let pinnedCell = null;
  let hoverCell = null;
  let episodesByDate = new Map();
  let renderedEpisodes = null;
  let monthIndex = [];
  let monthHeightByRows = new Map();
  let offsets = [];
  let totalHeight = 0;
  let mountedStart = -1;
  let mountedEnd = -1;
  let viewportAnchor = null;
  let activeRelayoutAnchor = null;
  let anchorFrame = null;
  let relayoutFrame = null;
  let scrollFrame = null;
  let relayoutEndTimer = null;
  let spotlightDateKey = null;
  let activeTooltipDate = null;
  let suppressScrollDismiss = false;
  let monthsSpacer = null;
  let monthsWindow = null;

  const tooltip = document.createElement("div");
  tooltip.className = "full-calendar-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  dom.fullCalendarModal.appendChild(tooltip);

  renderLegend();
  renderWeekdayHeader();
  ensureVirtualShell();
  bindDelegatedEvents();

  const resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (isOpen) scheduleCalendarRelayout();
      })
    : null;

  function renderLegend() {
    dom.fullCalendarLegend.innerHTML = COLLECTION_ORDER.map((kind) => {
      const meta = COLLECTION_META[kind];
      return `
        <span class="full-calendar__legend-item">
          <span class="full-calendar__legend-glyph" style="--glyph-color: ${meta.accent}">
            ${renderCollectionGlyphSvg(kind, "full-calendar__legend-glyph__svg")}
          </span>
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

  function ensureVirtualShell() {
    monthsSpacer = dom.fullCalendarMonths.querySelector(".full-calendar__months-spacer");
    monthsWindow = dom.fullCalendarMonths.querySelector(".full-calendar__months-window");
    if (monthsSpacer && monthsWindow) return;

    dom.fullCalendarMonths.innerHTML = "";
    monthsSpacer = document.createElement("div");
    monthsSpacer.className = "full-calendar__months-spacer";
    monthsSpacer.setAttribute("aria-hidden", "true");
    monthsWindow = document.createElement("div");
    monthsWindow.className = "full-calendar__months-window";
    dom.fullCalendarMonths.appendChild(monthsSpacer);
    dom.fullCalendarMonths.appendChild(monthsWindow);
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
    resizeObserver?.observe(dom.fullCalendarBody);

    if (!prefersReducedMotion()) {
      dom.fullCalendarModal.classList.add("is-entering");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dom.fullCalendarModal.classList.remove("is-entering"));
      });
    }

    requestAnimationFrame(() => {
      if (focusDate) {
        spotlightDateKey = focusDate;
        rebuildMonthHtmlForSpotlight();
      }

      relayoutCalendar({ preserveScroll: false, deferVisible: true });

      if (focusDate) {
        scrollToDate(focusDate, { center: true });
        showTooltipForDate(focusDate);
        dom.fullCalendarClose.focus();
        viewportAnchor = captureViewportAnchor();
        return;
      }

      dom.fullCalendarClose.focus();
      dom.fullCalendarBody.scrollLeft = 0;
      scrollToMonthsBottom();
      renderVisibleMonths();
      viewportAnchor = captureViewportAnchor();
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
    activeRelayoutAnchor = null;
    mountedStart = -1;
    mountedEnd = -1;
    resizeObserver?.unobserve(dom.fullCalendarBody);
    if (anchorFrame !== null) cancelAnimationFrame(anchorFrame);
    if (relayoutFrame !== null) cancelAnimationFrame(relayoutFrame);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    if (relayoutEndTimer !== null) clearTimeout(relayoutEndTimer);
    anchorFrame = null;
    relayoutFrame = null;
    scrollFrame = null;
    relayoutEndTimer = null;
    if (monthsWindow) monthsWindow.replaceChildren();

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
    ensureVirtualShell();

    if (episodes === renderedEpisodes && monthIndex.length) return;

    renderedEpisodes = episodes;
    episodesByDate = new Map();
    monthIndex = [];
    mountedStart = -1;
    mountedEnd = -1;

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
      monthsSpacer = null;
      monthsWindow = null;
      return;
    }

    ensureVirtualShell();
    for (let ordinal = min; ordinal <= max; ordinal += 1) {
      const year = Math.floor(ordinal / 12);
      const month = ordinal % 12;
      const meta = buildMonthMeta(year, month);
      monthIndex.push(meta);
    }
  }

  function buildMonthMeta(year, month) {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const rowCount = Math.ceil((firstWeekday + daysInMonth) / 7);
    return {
      ordinal: year * 12 + month,
      year,
      month,
      rowCount,
      firstWeekday,
      daysInMonth,
      html: renderMonth(year, month, firstWeekday, daysInMonth, rowCount),
    };
  }

  function renderProbeMonth(rowCount) {
    const cells = [];
    const totalCells = rowCount * 7;
    for (let index = 0; index < totalCells; index += 1) {
      cells.push('<span class="cal-cell cal-cell--blank" aria-hidden="true"></span>');
    }
    return `
      <section class="cal-month" data-rows="${rowCount}">
        <h3 class="cal-month__title">
          <span class="cal-month__name">${MONTH_NAMES[0]}</span>
          <span class="cal-month__year">2000</span>
        </h3>
        <div class="cal-month__grid">${cells.join("")}</div>
      </section>
    `;
  }

  function measureMonthHeights() {
    monthHeightByRows = new Map();
    if (!monthsWindow || monthIndex.length === 0) return;

    const probe = document.createElement("div");
    probe.className = "full-calendar__measure-probe";
    probe.setAttribute("aria-hidden", "true");
    monthsWindow.appendChild(probe);

    for (const rowCount of PROBE_ROW_COUNTS) {
      probe.innerHTML = renderProbeMonth(rowCount);
      const el = probe.firstElementChild;
      if (el) {
        monthHeightByRows.set(rowCount, el.getBoundingClientRect().height);
      }
    }

    probe.remove();
  }

  function computeOffsets() {
    offsets = new Array(monthIndex.length);
    let y = MONTHS_PADDING_TOP;
    for (let index = 0; index < monthIndex.length; index += 1) {
      offsets[index] = y;
      const height = monthHeightByRows.get(monthIndex[index].rowCount) || 0;
      y += height + (index < monthIndex.length - 1 ? MONTH_GAP : 0);
    }
    totalHeight = y;
  }

  function updateSpacerHeight() {
    if (!monthsSpacer) return;
    monthsSpacer.style.setProperty("--calendar-total-height", `${totalHeight}px`);
    monthsSpacer.style.height = `${totalHeight}px`;
  }

  function getMonthIndexForDate(dateKey) {
    const ordinal = dateOrdinal(dateKey);
    if (ordinal === null) return -1;
    return monthIndex.findIndex((entry) => entry.ordinal === ordinal);
  }

  function isDateInMountedRange(dateKey) {
    const index = getMonthIndexForDate(dateKey);
    if (index < 0) return false;
    return index >= mountedStart && index <= mountedEnd;
  }

  function syncTooltipWithMountedRange() {
    if (activeTooltipDate && !isDateInMountedRange(activeTooltipDate)) {
      pinnedCell = null;
      hoverCell = null;
      hideTooltip();
    }
  }

  function findMonthIndexAtOffset(offsetY) {
    if (!offsets.length) return 0;
    let low = 0;
    let high = offsets.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid] <= offsetY) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  function getStickyOffset() {
    const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
    const weekdayRect = dom.fullCalendarWeekdays.getBoundingClientRect();
    return Math.max(0, weekdayRect.bottom - bodyRect.top);
  }

  function getMonthsOffsetTop() {
    return dom.fullCalendarMonths.offsetTop;
  }

  function getMonthsScrollY() {
    return dom.fullCalendarBody.scrollTop + getStickyOffset() - getMonthsOffsetTop();
  }

  function scrollTopForMonthsY(monthsY) {
    return monthsY - getStickyOffset() + getMonthsOffsetTop();
  }

  function getVisibleMonthsHeight() {
    return dom.fullCalendarBody.clientHeight - getStickyOffset();
  }

  function scrollToMonthsBottom() {
    dom.fullCalendarBody.scrollTop = Math.max(0, scrollTopForMonthsY(totalHeight - getVisibleMonthsHeight()));
  }

  function renderVisibleMonths() {
    if (!monthsWindow || !monthIndex.length) return;

    syncTooltipWithMountedRange();

    const monthScrollY = getMonthsScrollY();
    const viewportHeight = getVisibleMonthsHeight();
    const firstVisible = findMonthIndexAtOffset(monthScrollY);
    const lastVisible = findMonthIndexAtOffset(monthScrollY + viewportHeight);

    const nextStart = Math.max(0, firstVisible - MONTH_OVERSCAN);
    const nextEnd = Math.min(monthIndex.length - 1, lastVisible + MONTH_OVERSCAN);

    if (nextStart === mountedStart && nextEnd === mountedEnd) return;

    mountedStart = nextStart;
    mountedEnd = nextEnd;

    const fragment = document.createDocumentFragment();
    for (let index = nextStart; index <= nextEnd; index += 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "cal-month-mount";
      wrapper.style.transform = `translateY(${offsets[index]}px)`;
      wrapper.innerHTML = monthIndex[index].html;
      fragment.appendChild(wrapper);
    }

    monthsWindow.replaceChildren(fragment);
    syncTooltipWithMountedRange();

    if (pinnedCell && !monthsWindow.contains(pinnedCell)) {
      pinnedCell = null;
    }
    if (hoverCell && !monthsWindow.contains(hoverCell)) {
      hoverCell = null;
    }

    if (activeTooltipDate && isDateInMountedRange(activeTooltipDate)) {
      const cell = monthsWindow.querySelector(`.cal-cell[data-date="${activeTooltipDate}"]`);
      if (cell && !tooltip.hidden) {
        positionTooltip(cell);
      }
    }
  }

  function scheduleVisibleMonths() {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      renderVisibleMonths();
    });
  }

  function relayoutCalendar({ preserveScroll = true, deferVisible = false } = {}) {
    if (!monthIndex.length || !monthsWindow) return;

    const anchor = preserveScroll ? (activeRelayoutAnchor || viewportAnchor || captureViewportAnchor()) : null;
    measureMonthHeights();
    computeOffsets();
    updateSpacerHeight();
    mountedStart = -1;
    mountedEnd = -1;

    if (!deferVisible) {
      renderVisibleMonths();
    }

    if (anchor?.date) {
      restoreViewportAnchor(anchor);
      renderVisibleMonths();
    }

    if (!preserveScroll) return;
    viewportAnchor = captureViewportAnchor();
  }

  function scheduleCalendarRelayout() {
    if (!isOpen) return;

    activeRelayoutAnchor ||= viewportAnchor || captureViewportAnchor();
    pinnedCell = null;
    hoverCell = null;
    hideTooltip();

    if (relayoutFrame !== null) cancelAnimationFrame(relayoutFrame);
    relayoutFrame = requestAnimationFrame(() => {
      relayoutFrame = null;
      relayoutCalendar({ preserveScroll: true });
    });

    if (relayoutEndTimer !== null) clearTimeout(relayoutEndTimer);
    relayoutEndTimer = setTimeout(() => {
      relayoutEndTimer = null;
      relayoutCalendar({ preserveScroll: true });
      activeRelayoutAnchor = null;
    }, 140);
  }

  function renderMonth(year, month, firstWeekday, daysInMonth, rowCount) {
    const cells = [];
    for (let blank = 0; blank < firstWeekday; blank += 1) {
      cells.push('<span class="cal-cell cal-cell--blank" aria-hidden="true"></span>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayEpisodes = episodesByDate.get(dateKey);
      const spotlightClass = dateKey === spotlightDateKey ? " cal-cell--spotlight" : "";

      if (dateKey === CANCELLED_DATE) {
        cells.push(`
          <button type="button" class="cal-cell cal-cell--event cal-cell--cancelled${spotlightClass}" data-date="${dateKey}" data-cancelled="true" aria-label="September 16, 2019: the day he got cancelled">
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
        let glyphs;
        if (kinds.length >= 2) {
          const topLeftKind = kinds.find((kind) => kind !== "paytch") || kinds[0];
          const bottomRightKind = kinds.includes("paytch")
            ? "paytch"
            : kinds.find((kind) => kind !== topLeftKind) || kinds[1];
          const topLeftAccent = COLLECTION_META[topLeftKind].accent;
          const bottomRightAccent = COLLECTION_META[bottomRightKind].accent;
          variantClass = "cal-cell--split";
          styleVars = `--accent-a: ${topLeftAccent}; --accent-b: ${bottomRightAccent}`;
          glyphs =
            renderCalCellGlyph(topLeftKind, "cal-cell__glyph--tl", topLeftAccent) +
            renderCalCellGlyph(bottomRightKind, "cal-cell__glyph--br", bottomRightAccent);
        } else {
          const accent = COLLECTION_META[kinds[0]]?.accent || "#888";
          variantClass = "cal-cell--single";
          styleVars = `--cell-accent: ${accent}`;
          glyphs = renderCalCellGlyph(kinds[0], "cal-cell__glyph--center", accent);
        }

        cells.push(`
          <button type="button" class="cal-cell cal-cell--event cal-cell--release ${variantClass}${spotlightClass}" data-date="${dateKey}" style="${styleVars}" aria-label="${escapeHtml(label)}">
            <span class="cal-cell__num">${day}</span>
            ${glyphs}
          </button>
        `);
      } else {
        cells.push(`<span class="cal-cell${spotlightClass}" data-date="${dateKey}"><span class="cal-cell__num">${day}</span></span>`);
      }
    }

    return `
      <section class="cal-month" data-rows="${rowCount}">
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

    const stickyOffset = getStickyOffset();
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

    const monthScrollY = getMonthsScrollY();
    const anchorMonthsY = monthScrollY + Math.max(36, Math.min(90, bodyRect.height * 0.18));
    const monthIdx = findMonthIndexAtOffset(anchorMonthsY);
    const meta = monthIndex[monthIdx];
    if (!meta) return viewportAnchor;

    const parts = parseDateParts(`${meta.year}-${String(meta.month + 1).padStart(2, "0")}-01`);
    if (!parts) return viewportAnchor;

    return {
      date: `${meta.year}-${String(meta.month + 1).padStart(2, "0")}-01`,
      offset: anchorMonthsY - offsets[monthIdx],
    };
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

    const monthIdx = getMonthIndexForDate(anchor.date);
    if (monthIdx < 0 || !offsets[monthIdx]) return;

    mountedStart = -1;
    mountedEnd = -1;
    renderVisibleMonths();

    const cell = monthsWindow?.querySelector(`.cal-cell[data-date="${anchor.date}"]`);
    if (cell) {
      const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
      const rect = cell.getBoundingClientRect();
      dom.fullCalendarBody.scrollLeft = 0;
      dom.fullCalendarBody.scrollTop += rect.top - bodyRect.top - anchor.offset;
      return;
    }

    dom.fullCalendarBody.scrollLeft = 0;
    dom.fullCalendarBody.scrollTop = Math.max(0, scrollTopForMonthsY(offsets[monthIdx] + anchor.offset));
    renderVisibleMonths();
  }

  function estimateScrollTopForDate(dateKey, { center = false } = {}) {
    const parts = parseDateParts(dateKey);
    const monthIdx = getMonthIndexForDate(dateKey);
    if (!parts || monthIdx < 0) return 0;

    const meta = monthIndex[monthIdx];
    const monthHeight = monthHeightByRows.get(meta.rowCount) || 0;
    const cellIndex = meta.firstWeekday + parts.day - 1;
    const row = Math.floor(cellIndex / 7);
    const rowHeight = monthHeight / meta.rowCount;
    const cellCenterY = offsets[monthIdx] + row * rowHeight + rowHeight / 2;

    if (!center) return Math.max(0, scrollTopForMonthsY(offsets[monthIdx]));

    const visibleHeight = getVisibleMonthsHeight();
    return Math.max(0, scrollTopForMonthsY(cellCenterY - visibleHeight / 2));
  }

  function scrollToDate(dateKey, { center = true } = {}) {
    if (!monthsWindow || getMonthIndexForDate(dateKey) < 0) return null;

    suppressScrollDismiss = true;
    dom.fullCalendarBody.scrollLeft = 0;
    dom.fullCalendarBody.scrollTop = estimateScrollTopForDate(dateKey, { center });
    mountedStart = -1;
    mountedEnd = -1;
    renderVisibleMonths();

    const cell = monthsWindow.querySelector(`.cal-cell[data-date="${dateKey}"]`);
    if (cell && center) {
      const bodyRect = dom.fullCalendarBody.getBoundingClientRect();
      const stickyOffset = getStickyOffset();
      const cellRect = cell.getBoundingClientRect();
      const visibleHeight = bodyRect.height - stickyOffset;
      const targetScroll = dom.fullCalendarBody.scrollTop
        + cellRect.top
        - bodyRect.top
        - stickyOffset
        - visibleHeight / 2
        + cellRect.height / 2;
      dom.fullCalendarBody.scrollTop = Math.max(0, targetScroll);
      renderVisibleMonths();
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressScrollDismiss = false;
      });
    });

    return monthsWindow.querySelector(`.cal-cell[data-date="${dateKey}"]`);
  }

  function clearSpotlight() {
    if (!spotlightDateKey) return;
    spotlightDateKey = null;
    if (renderedEpisodes && monthIndex.length) {
      rebuildMonthHtmlForSpotlight();
      if (isOpen) {
        mountedStart = -1;
        mountedEnd = -1;
        renderVisibleMonths();
      }
    }
  }

  function rebuildMonthHtmlForSpotlight() {
    for (const meta of monthIndex) {
      meta.html = renderMonth(meta.year, meta.month, meta.firstWeekday, meta.daysInMonth, meta.rowCount);
    }
  }

  function applySpotlight(dateKey) {
    spotlightDateKey = dateKey;
    rebuildMonthHtmlForSpotlight();
    if (!isOpen) return null;
    mountedStart = -1;
    mountedEnd = -1;
    const cell = scrollToDate(dateKey, { center: true });
    showTooltipForDate(dateKey);
    return cell;
  }

  function showTooltipForDate(dateKey) {
    if (!monthsWindow) return;
    const cell = monthsWindow.querySelector(`.cal-cell[data-date="${dateKey}"]`);
    if (!cell) return;
    pinnedCell = cell;
    showTooltip(cell);
  }

  function scheduleAnchorCapture() {
    if (activeRelayoutAnchor || anchorFrame !== null) return;
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = null;
      viewportAnchor = captureViewportAnchor();
    });
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
    activeTooltipDate = cell.dataset.date || null;

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
    activeTooltipDate = cell.dataset.date || CANCELLED_DATE;
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
    activeTooltipDate = null;
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
    scheduleVisibleMonths();
    scheduleAnchorCapture();
  }, { passive: true });
  window.addEventListener("resize", scheduleCalendarRelayout);
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
    applySpotlight,
  };
}
