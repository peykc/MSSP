const SECTION_ORDER = ["old", "new", "paytch"];
// September 16, 2019 at 2:15 PM ET (EDT, UTC-4)
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
const METRICS = Object.freeze({
  busiestYear: {
    label: "Busiest Year",
    value: (stats) => stats.busiestYearCount,
    format: (_, stats) => formatBusiestYear(stats),
  },
  hours: {
    label: "Hours",
    value: (stats) => stats.durationSecondsTotal / 3600,
    format: (_, stats) => formatDuration(stats.durationSecondsTotal),
  },
  storage: {
    label: "Storage",
    value: (stats) => stats.fileSizeBytesTotal,
    format: (value) => formatGiB(value),
  },
  averageLength: {
    label: "Avg Length",
    value: (stats) => stats.averageDurationSeconds,
    format: (value) => `${formatDuration(value)} avg`,
  },
});

export function createArchiveStatsView({ dom, state }) {
  let selectedMetric = "busiestYear";
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

  function buildGraphRows() {
    const metric = METRICS[selectedMetric];
    const rows = SECTION_ORDER.map((id) => ({
      id,
      collection: state.collections.find((item) => item.id === id),
      stats: archiveStats.collections[id],
    }));
    const maxValue = Math.max(...rows.map((row) => metric.value(row.stats)), 1);

    return rows.map(({ id, collection, stats }) => {
      const value = metric.value(stats);
      const scale = Math.max(0, value / maxValue);
      return `
        <div class="stats-bar-row" style="--bar-width: ${(scale * 100).toFixed(2)}%; --bar-accent: ${collection?.accent || "#f8f2ec"}">
          <div class="stats-bar-row__label">
            <span>${collection?.name || id}</span>
            <strong>${metric.format(value, stats)}</strong>
          </div>
          <div class="stats-bar" aria-hidden="true"><span class="stats-bar__fill"></span></div>
        </div>
      `;
    }).join("");
  }

  function updateGraph() {
    const graph = dom.archiveStatsPanel.querySelector(".stats-graph");
    if (graph) {
      graph.setAttribute("aria-label", `${METRICS[selectedMetric].label} by archive section`);
      graph.innerHTML = buildGraphRows();
    }
    for (const button of dom.archiveStatsPanel.querySelectorAll("[data-metric]")) {
      button.setAttribute("aria-pressed", String(button.dataset.metric === selectedMetric));
    }
  }

  function render() {
    if (!archiveStats) return renderLoading();
    const total = archiveStats.total;
    const pulseItems = buildPulseItems(total);

    const summaryItems = [
      { id: "busiestYear", value: formatBusiestYear(archiveStats.total), label: "busiest year" },
      { id: "hours", value: formatHours(archiveStats.total.durationSecondsTotal), label: "hours" },
      { id: "storage", value: formatGiB(archiveStats.total.fileSizeBytesTotal), label: "storage" },
      {
        id: "averageLength",
        value: formatDuration(archiveStats.total.averageDurationSeconds),
        label: "average length",
      },
    ];

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
      ${renderSafetySign()}
    `;

    bindPulseTouchPause(dom.archiveTidbitsPanel.querySelector(".archive-pulse__viewport"));

    dom.archiveStatsPanel.innerHTML = `
      <div class="archive-summary" role="group" aria-label="Archive statistic">
        ${summaryItems.map(({ id, value, label }) => `
          <button
            type="button"
            class="archive-summary__item"
            data-metric="${id}"
            aria-pressed="${id === selectedMetric}"
          >
            <span class="archive-summary__value">${value}</span>
            <span class="archive-summary__label">${label}</span>
          </button>
        `).join("")}
      </div>
      <div class="stats-graph" role="group" aria-label="${METRICS[selectedMetric].label} by archive section">
        ${buildGraphRows()}
      </div>
    `;

    for (const button of dom.archiveStatsPanel.querySelectorAll("[data-metric]")) {
      button.addEventListener("click", () => {
        selectedMetric = button.dataset.metric;
        updateGraph();
      });
    }
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

function buildPulseItems(total) {
  const spanDays = getDateSpanDays(total);
  const cadenceDays = total.episodeCount && spanDays ? spanDays / total.episodeCount : 0;
  const items = [];

  if (total.episodeCount > 0) {
    items.push({
      value: total.missedWeekCount.toLocaleString(),
      label: "Weeks Missed",
    });
  }

  if (total.longestStreakWeeks > 0) {
    items.push({
      value: `${total.longestStreakWeeks.toLocaleString()} weeks`,
      label: "Longest Streak",
    });
  }

  if (cadenceDays > 0) {
    items.push({
      value: `${cadenceDays.toFixed(1)} days`,
      label: "Avg. Drop Gap",
    });
  }

  if (total.episodeCount > 0) {
    items.push({
      value: total.exEpisodeCount.toLocaleString(),
      label: "EX Episodes",
    });
  }

  return items;
}

function renderSafetySign() {
  return `
    <section class="safety-sign" aria-label="Time since cancelled">
      <div class="safety-sign__header">
        <span>Days Since Cancelled</span>
        <span>Live</span>
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

function renderPulseItem({ value, label, attr, hidden = false }) {
  const ariaHidden = hidden ? ' aria-hidden="true"' : "";
  return `
    <div class="archive-pulse__item"${ariaHidden}>
      <span class="archive-pulse__label">${label}</span>
      <strong class="archive-pulse__value"${attr || ""}>${value}</strong>
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
