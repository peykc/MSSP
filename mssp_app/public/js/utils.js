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

export function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}
