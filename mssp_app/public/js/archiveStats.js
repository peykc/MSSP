import { renderCollectionGlyphSvg } from "./collectionGlyphs.js";

const SECTION_ORDER = ["old", "paytch", "new"];
// September 16, 2019 at 2:15 PM ET (EDT, UTC-4)
const CANCELLED_DATE = "2019-09-16";
const CANCELLED_AT_MS = Date.parse("2019-09-16T14:15:00-04:00");
const SEVEN_SEGMENTS = ["a", "b", "c", "d", "e", "f", "g"];
const SEVEN_SEGMENT_MAP = Object.freeze({
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
});
const HOURS_METRIC = Object.freeze({
  label: "Hours",
  value: (stats) => stats.durationSecondsTotal / 3600,
  format: (_, stats) => formatDuration(stats.durationSecondsTotal),
});

export function createArchiveStatsView({ dom, state, fullCalendarModal }) {
  let archiveStats = null;

  function setEpisodes(episodes) {
    state.archiveEpisodes = episodes;
    archiveStats = computeArchiveStats(episodes);
    render();
  }

  function renderLoading() {
    dom.archiveTidbitsPanel.innerHTML = "";
    dom.archiveStatsPanel.innerHTML = `
      <p class="archive-stats__message" role="status">Loading archive statistics...</p>
    `;
  }

  function renderError() {
    dom.archiveTidbitsPanel.innerHTML = "";
    dom.archiveStatsPanel.innerHTML = `
      <p class="archive-stats__message" role="status">Archive statistics are temporarily unavailable.</p>
    `;
  }

  function getHoursSegments() {
    const rows = SECTION_ORDER.map((id) => {
      const collection = state.collections.find((item) => item.id === id);
      const stats = archiveStats.collections[id];
      return {
        id,
        collection,
        stats,
        name: collection?.name || id,
        accent: collection?.accent || "#f8f2ec",
        seconds: stats.durationSecondsTotal,
      };
    });
    const totalSeconds = Math.max(
      rows.reduce((sum, row) => sum + row.seconds, 0),
      1,
    );

    return rows.map((row) => ({
      ...row,
      width: `${((row.seconds / totalSeconds) * 100).toFixed(2)}%`,
      formatted: HOURS_METRIC.format(HOURS_METRIC.value(row.stats), row.stats),
    }));
  }

  function renderHoursSlot(content, { id, width, accent }, className) {
    return `
      <span
        class="${className}"
        data-section="${id}"
        style="--segment-width: ${width}; --accent: ${accent}"
      >${content}</span>
    `;
  }

  function renderHoursSegment({ id, width, accent }) {
    return renderHoursSlot("", { id, width, accent }, "archive-hours__segment");
  }

  function renderHoursPanel() {
    const total = archiveStats.total;
    const segments = getHoursSegments();
    const barLabel = segments
      .map(({ name, formatted }) => `${name}: ${formatted}`)
      .join(", ");

    return `
      <section class="archive-hours" aria-label="Archive total length">
        <div class="archive-hours__relic">
          <header class="archive-hours__header">
            <h3 class="archive-hours__title">Total Length</h3>
            <p class="archive-hours__total">
              <span class="archive-hours__total-value">${formatHours(total.durationSecondsTotal)}</span>
              <span class="archive-hours__total-unit">Hours</span>
            </p>
          </header>
          <div class="archive-hours__chart">
            <div class="archive-hours__glyph-row" aria-hidden="true">
              ${segments.map((segment) => renderHoursSlot(
                renderCollectionGlyphSvg(segment.id, "archive-hours__glyph"),
                segment,
                "archive-hours__slot",
              )).join("")}
            </div>
            <div class="archive-hours__bar" role="img" aria-label="${barLabel}">
              ${segments.map(renderHoursSegment).join("")}
            </div>
            <div class="archive-hours__counts-row">
              ${segments.map((segment) => renderHoursSlot(
                `<span class="archive-hours__count">${formatHours(segment.seconds)}</span>`,
                segment,
                "archive-hours__slot",
              )).join("")}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function render() {
    if (!archiveStats) return renderLoading();
    const total = archiveStats.total;
    const pulseItems = buildPulseItems(total);

    const pulseMarkup = pulseItems.length
      ? `
        <section class="archive-pulse" aria-label="Archive pulse">
          <div class="archive-pulse__viewport">
            <div
              class="archive-pulse__track"
              style="--pulse-count: ${pulseItems.length}"
            >
              ${pulseItems.map((item) => renderPulseItem(item)).join("")}
              ${pulseItems.map((item) => renderPulseItem({ ...item, hidden: true })).join("")}
            </div>
          </div>
        </section>
      `
      : "";

    dom.archiveTidbitsPanel.innerHTML = `
      ${pulseMarkup}
      ${renderSafetySign(Boolean(state.archiveEpisodes.length))}
    `;

    bindPulseTouchPause(dom.archiveTidbitsPanel.querySelector(".archive-pulse__viewport"));

    dom.archiveTidbitsPanel.querySelector("[data-open-cancelled-calendar]")?.addEventListener("click", (event) => {
      if (!state.archiveEpisodes.length) return;
      fullCalendarModal.open(state.archiveEpisodes, event.currentTarget, { focusDate: CANCELLED_DATE });
    });

    dom.archiveStatsPanel.innerHTML = renderHoursPanel();
  }

  setInterval(() => {
    const sign = dom.archiveTidbitsPanel.querySelector("[data-cancelled-sign]");
    if (sign) {
      sign.innerHTML = renderSafetySignDigits();
      sign.setAttribute("aria-label", formatSafetySignLabel());
    }
  }, 1000);

  renderLoading();
  return {
    render,
    renderError,
    setEpisodes,
  };
}

export function computeArchiveStats(episodes) {
  const collections = Object.fromEntries(SECTION_ORDER.map((id) => [id, emptyStats()]));
  const total = emptyStats();

  for (const episode of episodes) {
    addEpisode(total, episode);
    if (collections[episode.collectionKind]) addEpisode(collections[episode.collectionKind], episode);
  }

  finalizeStats(total);
  for (const stats of Object.values(collections)) finalizeStats(stats);
  return { total, collections };
}

function emptyStats() {
  return {
    episodeCount: 0,
    durationMetadataCount: 0,
    fileSizeMetadataCount: 0,
    durationSecondsTotal: 0,
    fileSizeBytesTotal: 0,
    averageDurationSeconds: 0,
    averageFileSizeBytes: 0,
    exEpisodeCount: 0,
    firstEpisodeDate: "",
    lastEpisodeDate: "",
    episodeDates: [],
    episodesByYear: {},
    busiestYear: "",
    busiestYearCount: 0,
    missedWeekCount: 0,
    longestStreakWeeks: 0,
  };
}

function addEpisode(stats, episode) {
  stats.episodeCount += 1;
  if (String(episode.episode || "").toUpperCase() === "EX") stats.exEpisodeCount += 1;
  if (episode.date && (!stats.firstEpisodeDate || episode.date < stats.firstEpisodeDate)) {
    stats.firstEpisodeDate = episode.date;
  }
  if (episode.date && (!stats.lastEpisodeDate || episode.date > stats.lastEpisodeDate)) {
    stats.lastEpisodeDate = episode.date;
  }
  const year = getYear(episode.date);
  if (year) stats.episodesByYear[year] = (stats.episodesByYear[year] || 0) + 1;
  if (episode.date) stats.episodeDates.push(episode.date);
  const duration = Number(episode.durationSeconds);
  const fileSize = Number(episode.fileSizeBytes);
  if (episode.durationSeconds !== null && episode.durationSeconds !== "" && Number.isFinite(duration)) {
    stats.durationMetadataCount += 1;
    stats.durationSecondsTotal += duration;
  }
  if (episode.fileSizeBytes !== null && episode.fileSizeBytes !== "" && Number.isFinite(fileSize)) {
    stats.fileSizeMetadataCount += 1;
    stats.fileSizeBytesTotal += fileSize;
  }
}

function finalizeStats(stats) {
  if (stats.durationMetadataCount) {
    stats.averageDurationSeconds = stats.durationSecondsTotal / stats.durationMetadataCount;
  }
  if (stats.fileSizeMetadataCount) {
    stats.averageFileSizeBytes = stats.fileSizeBytesTotal / stats.fileSizeMetadataCount;
  }
  for (const [year, count] of Object.entries(stats.episodesByYear)) {
    if (count > stats.busiestYearCount) {
      stats.busiestYear = year;
      stats.busiestYearCount = count;
    }
  }
  const releaseWeeks = getReleaseWeeks(stats.episodeDates);
  stats.missedWeekCount = countMissedWeeks(releaseWeeks);
  stats.longestStreakWeeks = countLongestWeeklyStreak(releaseWeeks);
}

function getReleaseWeeks(dates) {
  return [...new Set(dates)]
    .map(getWeekStartTime)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function getWeekStartTime(date) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return NaN;
  const day = new Date(parsed).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return parsed - (daysSinceMonday * 86400000);
}

function countMissedWeeks(releaseWeeks) {
  const weeks = [...new Set(releaseWeeks)]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let missedWeeks = 0;

  for (let index = 1; index < weeks.length; index += 1) {
    const weekGap = Math.round((weeks[index] - weeks[index - 1]) / 604800000);
    missedWeeks += Math.max(0, weekGap - 1);
  }

  return missedWeeks;
}

function countLongestWeeklyStreak(releaseWeeks) {
  const weeks = [...new Set(releaseWeeks)]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!weeks.length) return 0;

  let longest = 1;
  let current = 1;
  for (let index = 1; index < weeks.length; index += 1) {
    const weekGap = Math.round((weeks[index] - weeks[index - 1]) / 604800000);
    current = weekGap === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }

  return longest;
}

const PULSE_ICONS = Object.freeze({
  calendar: `<svg class="archive-pulse__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zm12 8H5v10h14V10z"/></svg>`,
  flame: `<svg class="archive-pulse__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9.32 15.653a.812.812 0 0 1-.086-.855c.176-.342.245-.733.2-1.118a2.106 2.106 0 0 0-.267-.779 2.027 2.027 0 0 0-.541-.606 3.96 3.96 0 0 1-1.481-2.282c-1.708 2.239-1.053 3.51-.235 4.63a.748.748 0 0 1-.014.901.87.87 0 0 1-.394.283.838.838 0 0 1-.478.023c-1.105-.27-2.145-.784-2.85-1.603a4.686 4.686 0 0 1-.906-1.555 4.811 4.811 0 0 1-.263-1.797s-.133-2.463 2.837-4.876c0 0 3.51-2.978 2.292-5.18a.621.621 0 0 1 .112-.653.558.558 0 0 1 .623-.147l.146.058a7.63 7.63 0 0 1 2.96 3.5c.58 1.413.576 3.06.184 4.527.325-.292.596-.641.801-1.033l.029-.064c.198-.477.821-.325 1.055-.013.086.137 2.292 3.343 1.107 6.048a5.516 5.516 0 0 1-1.84 2.027 6.127 6.127 0 0 1-2.138.893.834.834 0 0 1-.472-.038.867.867 0 0 1-.381-.29zM7.554 7.892a.422.422 0 0 1 .55.146c.04.059.066.126.075.198l.045.349c.02.511.014 1.045.213 1.536.206.504.526.95.932 1.298a3.06 3.06 0 0 1 1.16 1.422c.22.564.25 1.19.084 1.773a4.123 4.123 0 0 0 1.39-.757l.103-.084c.336-.277.613-.623.813-1.017.201-.393.322-.825.354-1.269.065-1.025-.284-2.054-.827-2.972-.248.36-.59.639-.985.804-.247.105-.509.17-.776.19a.792.792 0 0 1-.439-.1.832.832 0 0 1-.321-.328.825.825 0 0 1-.035-.729c.412-.972.54-2.05.365-3.097a5.874 5.874 0 0 0-1.642-3.16c-.156 2.205-2.417 4.258-2.881 4.7a3.537 3.537 0 0 1-.224.194c-2.426 1.965-2.26 3.755-2.26 3.834a3.678 3.678 0 0 0 .459 2.043c.365.645.89 1.177 1.52 1.54C4.5 12.808 4.5 10.89 7.183 8.14l.372-.25z"/></svg>`,
  scales: `<svg class="archive-pulse__icon" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M422.957,478.609h-16.696v-89.044c0-58.16-33.276-108.601-81.734-133.565c48.954-25.22,81.734-75.864,81.734-133.565V33.391h16.696c9.217,0,16.696-7.473,16.696-16.696C439.652,7.473,432.174,0,422.957,0C355.995,0,156.678,0,89.044,0c-9.217,0-16.696,7.473-16.696,16.696c0,9.223,7.479,16.696,16.696,16.696h16.696v89.044c0,57.692,32.771,108.341,81.734,133.565c-48.459,24.964-81.734,75.405-81.734,133.565v89.044H89.044c-9.217,0-16.696,7.473-16.696,16.696c0,9.223,7.479,16.696,16.696,16.696c111.521,0,222.498,0,333.913,0c9.217,0,16.696-7.473,16.696-16.696C439.652,486.082,432.174,478.609,422.957,478.609z M139.641,132.511c-0.817-9.509-0.511-5.456-0.511-99.12H372.87c0,93.664,0.306,89.611-0.511,99.12H139.641z M372.87,459.661c-92.104-76.755-88.747-75.372-100.174-79.41v-18.512c0-9.223-7.479-16.696-16.696-16.696s-16.696,7.473-16.696,16.696v18.511c-11.307,3.996-7.768,2.403-100.174,79.41v-70.095c0-58.759,43.63-107.391,100.174-115.536v20.927c0,9.223,7.479,16.696,16.696,16.696s16.696-7.473,16.696-16.696v-20.927c56.544,8.145,100.174,56.777,100.174,115.536V459.661z"/></svg>`,
  book: `<svg class="archive-pulse__icon archive-pulse__icon--stroke" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 6.90909C10.8999 5.50893 9.20406 4.10877 5.00119 4.00602C4.72513 3.99928 4.5 4.22351 4.5 4.49965C4.5 6.54813 4.5 14.3034 4.5 16.597C4.5 16.8731 4.72515 17.09 5.00114 17.099C9.20405 17.2364 10.8999 19.0998 12 20.5M12 6.90909C13.1001 5.50893 14.7959 4.10877 18.9988 4.00602C19.2749 3.99928 19.5 4.21847 19.5 4.49461C19.5 6.78447 19.5 14.3064 19.5 16.5963C19.5 16.8724 19.2749 17.09 18.9989 17.099C14.796 17.2364 13.1001 19.0998 12 20.5M12 6.90909L12 20.5" stroke="currentColor" stroke-linejoin="round"/><path d="M19.2353 6H21.5C21.7761 6 22 6.22386 22 6.5V19.539C22 19.9436 21.5233 20.2124 21.1535 20.0481C20.3584 19.6948 19.0315 19.2632 17.2941 19.2632C14.3529 19.2632 12 21 12 21C12 21 9.64706 19.2632 6.70588 19.2632C4.96845 19.2632 3.64156 19.6948 2.84647 20.0481C2.47668 20.2124 2 19.9436 2 19.539V6.5C2 6.22386 2.22386 6 2.5 6H4.76471" stroke="currentColor" stroke-linejoin="round"/></svg>`,
});

function buildPulseItems(total) {
  const spanDays = getDateSpanDays(total);
  const cadenceDays = total.episodeCount && spanDays ? spanDays / total.episodeCount : 0;
  const items = [];

  if (total.episodeCount > 0) {
    items.push({
      value: total.missedWeekCount.toLocaleString(),
      label: "Weeks Missed",
      icon: "calendar",
    });
  }

  if (total.longestStreakWeeks > 0) {
    items.push({
      value: `${total.longestStreakWeeks.toLocaleString()} weeks`,
      label: "Longest Streak",
      icon: "flame",
    });
  }

  if (cadenceDays > 0) {
    items.push({
      value: `${cadenceDays.toFixed(1)} days`,
      label: "Avg. Drop Gap",
      icon: "scales",
    });
  }

  if (total.episodeCount > 0) {
    items.push({
      value: total.exEpisodeCount.toLocaleString(),
      label: "EX Episodes",
      icon: "book",
    });
  }

  return items;
}

function renderSafetySignCalendarButton(disabled) {
  return `
    <button
      type="button"
      class="safety-sign__calendar"
      data-open-cancelled-calendar
      aria-label="View cancellation date on archive calendar"
      ${disabled ? "disabled" : ""}
    >
      <svg class="safety-sign__calendar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zm12 8H5v10h14V10z"/>
      </svg>
    </button>
  `;
}

function renderSafetySign(hasArchiveEpisodes) {
  return `
    <section class="safety-sign" aria-label="Time since cancelled">
      <div class="safety-sign__header">
        <span>Days Since Cancelled</span>
        ${renderSafetySignCalendarButton(!hasArchiveEpisodes)}
      </div>
      <div class="safety-sign__display" data-cancelled-sign role="img" aria-label="${formatSafetySignLabel()}">
        ${renderSafetySignDigits()}
      </div>
    </section>
  `;
}

function renderSafetySignDigits() {
  const { days, hours, minutes, seconds } = getCancelledElapsed();
  const groups = [
    { value: String(days).padStart(4, "0"), unit: "Days" },
    { value: String(hours).padStart(2, "0"), unit: "Hrs" },
    { value: String(minutes).padStart(2, "0"), unit: "Min" },
    { value: String(seconds).padStart(2, "0"), unit: "Sec" },
  ];
  return groups.map(renderSegmentGroup).join('<span class="seg-colon" aria-hidden="true"><i></i><i></i></span>');
}

function renderSegmentGroup({ value, unit }) {
  const digits = value.split("").map(renderSevenSegmentDigit).join("");
  return `
    <span class="seg-group">
      <span class="seg-group__digits">${digits}</span>
      <span class="seg-group__unit">${unit}</span>
    </span>
  `;
}

function renderSevenSegmentDigit(char) {
  const active = SEVEN_SEGMENT_MAP[char] || "";
  const segments = SEVEN_SEGMENTS.map(
    (segment) => `<span class="seg seg--${segment}${active.includes(segment) ? " is-on" : ""}"></span>`,
  ).join("");
  return `<span class="seg-digit" aria-hidden="true">${segments}</span>`;
}

function formatSafetySignLabel() {
  const { days, hours, minutes, seconds } = getCancelledElapsed();
  return `${days.toLocaleString()} days, ${hours} hours, ${minutes} minutes, ${seconds} seconds since cancelled`;
}

function renderPulseItem({ value, label, icon, attr, hidden = false }) {
  const ariaHidden = hidden ? ' aria-hidden="true"' : "";
  const iconMarkup = PULSE_ICONS[icon] || "";
  return `
    <div class="archive-pulse__item"${ariaHidden}>
      <span class="archive-pulse__relic">
        <span class="archive-pulse__seal" aria-hidden="true">
          <span class="archive-pulse__seal-arm">
            <span class="archive-pulse__seal-line"></span>
            <span class="archive-pulse__seal-tip"></span>
          </span>
          ${iconMarkup}
          <span class="archive-pulse__seal-arm">
            <span class="archive-pulse__seal-tip"></span>
            <span class="archive-pulse__seal-line"></span>
          </span>
        </span>
        <span class="archive-pulse__label">${label}</span>
        <strong class="archive-pulse__value"${attr || ""}>${value}</strong>
      </span>
    </div>
  `;
}

function bindPulseTouchPause(viewport) {
  if (!viewport) return;
  const pause = () => viewport.classList.add("is-touching");
  const resume = () => viewport.classList.remove("is-touching");
  viewport.addEventListener("touchstart", pause, { passive: true });
  viewport.addEventListener("touchend", resume, { passive: true });
  viewport.addEventListener("touchcancel", resume, { passive: true });
}

function formatBusiestYear(stats) {
  if (!stats.busiestYear || !stats.busiestYearCount) return "Unknown";
  return `${stats.busiestYear} · ${stats.busiestYearCount.toLocaleString()} eps`;
}

function formatDuration(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${String(remainder).padStart(2, "0")}m` : `${remainder}m`;
}

function getDateSpanDays(stats) {
  const first = Date.parse(stats.firstEpisodeDate);
  const last = Date.parse(stats.lastEpisodeDate);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(1, Math.round((last - first) / 86400000) + 1);
}

function getCancelledElapsed() {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - CANCELLED_AT_MS) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

function getYear(date) {
  return String(date || "").slice(0, 4);
}

function formatHours(seconds) {
  return Math.round((Number(seconds) || 0) / 3600).toLocaleString();
}

function formatGiB(bytes) {
  return `${((Number(bytes) || 0) / (1024 ** 3)).toFixed(1)} GiB`;
}
