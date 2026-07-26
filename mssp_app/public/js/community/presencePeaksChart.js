const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 72;
const DEFAULT_PAD = 10;

export function createPresencePeaksChart({
  root,
  fetchPeaks,
  preferReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
} = {}) {
  if (!root || typeof fetchPeaks !== "function") {
    throw new Error("Presence peaks chart requires root and fetchPeaks");
  }

  let open = false;
  let loading = false;
  let days = null;
  let allTimePeak = null;

  const chart = root.querySelector("[data-peaks-chart]");
  const meta = root.querySelector("[data-peaks-meta]");
  if (!chart) throw new Error("Presence peaks chart requires [data-peaks-chart]");

  function isOpen() {
    return open;
  }

  async function toggle() {
    if (open) {
      close();
      return false;
    }
    return openPanel();
  }

  async function openPanel() {
    if (loading) return open;
    loading = true;
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    root.classList.add("is-loading");
    try {
      if (!days) {
        const payload = await fetchPeaks();
        days = Array.isArray(payload?.days) ? payload.days : [];
        allTimePeak = Number.isFinite(payload?.peak) ? payload.peak : null;
      }
      render();
      open = true;
      root.classList.add("is-open");
      if (!preferReducedMotion()) {
        requestAnimationFrame(() => root.classList.add("is-visible"));
      } else {
        root.classList.add("is-visible");
      }
      return true;
    } catch {
      if (!open) {
        root.hidden = true;
        root.setAttribute("aria-hidden", "true");
      }
      return false;
    } finally {
      loading = false;
      root.classList.remove("is-loading");
    }
  }

  function close() {
    open = false;
    root.classList.remove("is-open", "is-visible");
    root.setAttribute("aria-hidden", "true");
    if (preferReducedMotion()) {
      root.hidden = true;
      return;
    }
    window.setTimeout(() => {
      if (!open) root.hidden = true;
    }, 280);
  }

  function render() {
    const series = normalizeDays(days);
    if (meta) {
      const peakLabel = Number.isFinite(allTimePeak) ? String(allTimePeak) : "—";
      meta.textContent = series.length
        ? `Peak ${peakLabel} · ${series.length} day${series.length === 1 ? "" : "s"}`
        : "No peak history yet";
    }

    if (!series.length) {
      chart.replaceChildren();
      return;
    }

    const width = DEFAULT_WIDTH;
    const height = DEFAULT_HEIGHT;
    const geometry = buildPeaksGeometry(series, { width, height, pad: DEFAULT_PAD });
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.setAttribute("aria-hidden", "true");
    chart.replaceChildren(
      createSvgChild("path", {
        class: "dawgs-peaks__area",
        d: geometry.area,
      }),
      createSvgChild("polyline", {
        class: "dawgs-peaks__line",
        points: geometry.points,
        fill: "none",
      }),
      ...geometry.dots.map((dot) => createSvgChild("circle", {
        class: "dawgs-peaks__dot",
        cx: String(dot.x),
        cy: String(dot.y),
        r: "2.4",
      })),
      ...geometry.labels.map((label) => {
        const text = createSvgChild("text", {
          class: "dawgs-peaks__label",
          x: String(label.x),
          y: String(height - 2),
          "text-anchor": "middle",
        });
        text.textContent = label.text;
        return text;
      }),
    );
  }

  return { toggle, open: openPanel, close, isOpen };
}

export function buildPeaksGeometry(days, {
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  pad = DEFAULT_PAD,
} = {}) {
  const series = normalizeDays(days);
  if (!series.length) {
    return { points: "", area: "", dots: [], labels: [], max: 0 };
  }

  const max = Math.max(...series.map((entry) => entry.peak), 1);
  const innerW = Math.max(width - (pad * 2), 1);
  const innerH = Math.max(height - (pad * 2) - 12, 1);
  const bottom = pad + innerH;

  const dots = series.map((entry, index) => {
    const x = series.length === 1
      ? pad + (innerW / 2)
      : pad + ((index / (series.length - 1)) * innerW);
    const y = bottom - ((entry.peak / max) * innerH);
    return { x, y, day: entry.day, peak: entry.peak };
  });

  const points = dots.map((dot) => `${round(dot.x)},${round(dot.y)}`).join(" ");
  const first = dots[0];
  const last = dots[dots.length - 1];
  const area = [
    `M ${round(first.x)} ${round(bottom)}`,
    ...dots.map((dot) => `L ${round(dot.x)} ${round(dot.y)}`),
    `L ${round(last.x)} ${round(bottom)}`,
    "Z",
  ].join(" ");

  const labels = pickDayLabels(series, dots);

  return { points, area, dots, labels, max };
}

export function createSecretTapGesture({
  tapsRequired = 5,
  gapMs = 650,
  now = () => Date.now(),
} = {}) {
  let taps = 0;
  let lastTapAt = 0;

  return function registerTap() {
    const at = now();
    taps = at - lastTapAt > gapMs ? 1 : taps + 1;
    lastTapAt = at;
    if (taps < tapsRequired) return false;
    taps = 0;
    return true;
  };
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  return days
    .filter((entry) => entry && typeof entry.day === "string" && Number.isFinite(entry.peak) && entry.peak >= 0)
    .map((entry) => ({ day: entry.day, peak: Math.floor(entry.peak) }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

function pickDayLabels(series, dots) {
  if (!series.length) return [];
  if (series.length <= 4) {
    return series.map((entry, index) => ({
      text: formatDayLabel(entry.day),
      x: dots[index].x,
    }));
  }
  const indexes = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  return [...new Set(indexes)].map((index) => ({
    text: formatDayLabel(series[index].day),
    x: dots[index].x,
  }));
}

function formatDayLabel(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return `${Number(match[2])}/${Number(match[3])}`;
}

function createSvgChild(name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
