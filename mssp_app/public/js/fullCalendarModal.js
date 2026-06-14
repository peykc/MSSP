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

  const tooltip = document.createElement("div");
  tooltip.className = "full-calendar-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  dom.fullCalendarModal.appendChild(tooltip);

  renderLegend();
  renderWeekdayHeader();
  bindDelegatedEvents();

  const cellResizeObserver = new ResizeObserver(() => updateIntrinsicSizes());
  cellResizeObserver.observe(dom.fullCalendarMonths);

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

  function open(episodes, trigger) {
    restoreFocusTo = trigger;
    render(episodes);
    dom.fullCalendarModal.hidden = false;
    dom.fullCalendarModal.setAttribute("aria-hidden", "false");
    dom.app.inert = true;
    dom.miniPlayer.inert = true;
    document.body.classList.add("calendar-open");
    isOpen = true;
    requestAnimationFrame(() => {
      dom.fullCalendarClose.focus();
      dom.fullCalendarBody.scrollTop = dom.fullCalendarBody.scrollHeight;
    });
  }

  function close() {
    if (!isOpen) return;
    pinnedCell = null;
    hoverCell = null;
    hideTooltip();
    dom.fullCalendarModal.hidden = true;
    dom.fullCalendarModal.setAttribute("aria-hidden", "true");
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

  function render(episodes) {
    pinnedCell = null;
    hoverCell = null;
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
    requestAnimationFrame(updateIntrinsicSizes);
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
      if (dayEpisodes && dayEpisodes.length) {
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
          <button type="button" class="cal-cell cal-cell--release ${variantClass}" data-date="${dateKey}" style="${styleVars}" aria-label="${escapeHtml(label)}">
            <span class="cal-cell__num">${day}</span>
            ${dots}
          </button>
        `);
      } else {
        cells.push(`<span class="cal-cell"><span class="cal-cell__num">${day}</span></span>`);
      }
    }

    const rows = Math.ceil((firstWeekday + daysInMonth) / 7);
    return `
      <section class="cal-month" data-rows="${rows}">
        <h3 class="cal-month__title">${MONTH_NAMES[month]} ${year}</h3>
        <div class="cal-month__grid">${cells.join("")}</div>
      </section>
    `;
  }

  function updateIntrinsicSizes() {
    const styles = getComputedStyle(dom.fullCalendarMonths);
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padRight = parseFloat(styles.paddingRight) || 0;
    const contentWidth = dom.fullCalendarMonths.clientWidth - padLeft - padRight;
    const cell = (contentWidth - 6 * 4) / 7;
    if (!(cell > 0)) return;
    for (const month of dom.fullCalendarMonths.querySelectorAll(".cal-month")) {
      const rows = Number(month.dataset.rows) || 5;
      const height = Math.round(rows * cell + (rows - 1) * 4 + 30);
      month.style.containIntrinsicSize = `auto ${height}px`;
    }
  }

  function bindDelegatedEvents() {
    dom.fullCalendarMonths.addEventListener("mouseover", (event) => {
      const cell = event.target.closest(".cal-cell--release");
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
      const cell = event.target.closest(".cal-cell--release");
      if (cell) showTooltip(cell);
    });
    dom.fullCalendarMonths.addEventListener("focusout", (event) => {
      const cell = event.target.closest(".cal-cell--release");
      if (cell && cell !== pinnedCell) hideTooltip();
    });
    dom.fullCalendarMonths.addEventListener("click", (event) => {
      const cell = event.target.closest(".cal-cell--release");
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
    const dateKey = cell.dataset.date;
    const dayEpisodes = episodesByDate.get(dateKey);
    if (!dayEpisodes || !dayEpisodes.length) return;

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
    if (!event.target.closest(".cal-cell--release")) {
      pinnedCell = null;
      hideTooltip();
    }
  });
  dom.fullCalendarBody.addEventListener("scroll", () => {
    if (!pinnedCell && hoverCell === null) return;
    pinnedCell = null;
    hoverCell = null;
    hideTooltip();
  }, { passive: true });
  document.addEventListener("keydown", handleKeydown);

  return {
    close,
    open,
  };
}
