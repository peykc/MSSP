export function formatCount(count) {
  return `${count.toLocaleString()} episode${count === 1 ? "" : "s"}`;
}

export function formatDateRange(collection) {
  if (!collection.startDate || !collection.endDate) return formatCount(collection.count);
  const startYear = collection.startDate.slice(0, 4);
  const endYear = collection.endDate.slice(0, 4);
  return startYear === endYear ? startYear : `${startYear} - ${endYear}`;
}

export function formatEpisodeLabel(episode) {
  return episode.episode ? `Ep. ${episode.episode}` : "Extra";
}

export function formatPlayerDate(dateString) {
  if (!dateString) return "Unknown date";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return dateString;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function formatEpisodeDuration(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h\u00a0${minutes}m` : `${hours}h`;
}

export function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}
