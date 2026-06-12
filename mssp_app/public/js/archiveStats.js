const SECTION_ORDER = ["old", "new", "paytch"];
// September 16, 2019 at 2:15 PM ET (EDT, UTC-4)
const CANCELLED_AT_MS = Date.parse("2019-09-16T14:15:00-04:00");
const METRICS = Object.freeze({
  span: {
    label: "Span",
    value: (stats) => getYearCount(stats),
    format: (_, stats) => formatYearCount(stats),
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
  let selectedMetric = "span";
  let archiveStats = null;

  function setEpisodes(episodes) {
    state.archiveEpisodes = episodes;
    archiveStats = computeArchiveStats(episodes);
    render();
  }

  function renderLoading() {
    dom.archiveStatsPanel.innerHTML = `
      <p class="archive-stats__message" role="status">Loading archive statistics...</p>
    `;
  }

  function renderError() {
    dom.archiveStatsPanel.innerHTML = `
      <p class="archive-stats__message" role="status">Archive statistics are temporarily unavailable.</p>
    `;
  }

  function render() {
    if (!archiveStats) return renderLoading();
    const metric = METRICS[selectedMetric];
    const rows = SECTION_ORDER.map((id) => ({
      id,
      collection: state.collections.find((item) => item.id === id),
      stats: archiveStats.collections[id],
    }));
    const maxValue = Math.max(...rows.map((row) => metric.value(row.stats)), 1);

    const total = archiveStats.total;
    const spanDays = getDateSpanDays(total);
    const cadenceDays = total.episodeCount ? spanDays / total.episodeCount : 0;
    const tidbits = [
      { value: formatDaysSinceCancelled(), label: "days since cancelled", attr: " data-cancelled-days" },
      { value: total.exEpisodeCount.toLocaleString(), label: "EX episodes" },
      { value: cadenceDays ? `${cadenceDays.toFixed(1)} days` : "&mdash;", label: "between drops" },
      {
        value: total.busiestYear || "&mdash;",
        label: total.busiestYear
          ? `busiest year &middot; ${total.busiestYearCount.toLocaleString()} eps`
          : "busiest year",
      },
    ];

    const summaryItems = [
      { id: "span", value: getYearCount(archiveStats.total).toLocaleString(), label: "years" },
      { id: "hours", value: formatHours(archiveStats.total.durationSecondsTotal), label: "hours" },
      { id: "storage", value: formatGiB(archiveStats.total.fileSizeBytesTotal), label: "storage" },
      {
        id: "averageLength",
        value: formatDuration(archiveStats.total.averageDurationSeconds),
        label: "average length",
      },
    ];

    dom.archiveStatsPanel.innerHTML = `
      <ul class="archive-tidbits" aria-label="Archive details">
        ${tidbits.map(({ value, label, attr }) => `
          <li class="archive-tidbits__item">
            <strong${attr || ""}>${value}</strong>
            <span>${label}</span>
          </li>
        `).join("")}
      </ul>
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
      <div class="stats-graph" role="group" aria-label="${metric.label} by archive section">
        ${rows.map(({ id, collection, stats }) => {
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
        }).join("")}
      </div>
    `;

    for (const button of dom.archiveStatsPanel.querySelectorAll("[data-metric]")) {
      button.addEventListener("click", () => {
        selectedMetric = button.dataset.metric;
        render();
      });
    }
  }

  setInterval(() => {
    const element = dom.archiveStatsPanel.querySelector("[data-cancelled-days]");
    if (element) element.textContent = formatDaysSinceCancelled();
  }, 60000);

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
    episodesByYear: {},
    busiestYear: "",
    busiestYearCount: 0,
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

function formatDaysSinceCancelled() {
  const days = Math.floor((Date.now() - CANCELLED_AT_MS) / 86400000);
  return Math.max(0, days).toLocaleString();
}

function getYearCount(stats) {
  const firstYear = Number(getYear(stats.firstEpisodeDate));
  const lastYear = Number(getYear(stats.lastEpisodeDate));
  if (!firstYear || !lastYear) return 0;
  return Math.max(1, lastYear - firstYear + 1);
}

function formatYearCount(stats) {
  const count = getYearCount(stats);
  if (!count) return "Unknown";
  return count === 1 ? "1 year" : `${count} years`;
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
