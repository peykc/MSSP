const CURATED_PALETTES = Object.freeze({
  anthology: ["#6e9b8f", "#5d7895", "#a08f6f"],
  old: ["#6c94a6", "#718495", "#a89779"],
  new: ["#bd8355", "#956957", "#867651"],
  paytch: ["#f96854", "#c45a48", "#765f4f"],
  default: ["#64748b", "#855f76", "#6a8067"],
});

const STAMP_WIDTH = 80;
const STAMP_HEIGHT = 142;
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
const CROSSFADE_MS = 1100;
const BASE_FILL = "#1f1d1c";

/** Soft discs via oversized radial gradients + screen blend (Safari-safe separable mode). */
const GLOW_SCALE = 2.75;
const BLOBS = Object.freeze([
  { x: 0.18, y: 0.12, radius: 0.42, orbit: 0.06, spin: 0.00022, phase: 0.0 },
  { x: 0.88, y: 0.92, radius: 0.46, orbit: 0.07, spin: -0.00018, phase: 1.7 },
  { x: 0.48, y: 0.46, radius: 0.38, orbit: 0.05, spin: 0.00014, phase: 3.1 },
]);

export function createCoverAmbient({ root }) {
  const stage = root.querySelector(".full-player__ambient");
  const canvas = root.querySelector(".full-player__ambient-canvas");
  const paletteCache = new Map();
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  let activeCoverUrl = "";
  let requestVersion = 0;
  let frameId = 0;
  let lastPaintAt = 0;
  let startTime = performance.now();
  let displayColors = CURATED_PALETTES.default.map(parseColor);
  let fromColors = displayColors.map((color) => ({ ...color }));
  let toColors = displayColors.map((color) => ({ ...color }));
  let crossfadeStartedAt = 0;
  let crossfading = false;
  let context = null;

  if (canvas) {
    canvas.width = STAMP_WIDTH;
    canvas.height = STAMP_HEIGHT;
    context = canvas.getContext("2d", { alpha: false });
  }

  // Safari canvas landmines (both fail silently):
  // 1) ctx.filter blur is ignored on older WebKit — softness is radial-gradient.
  // 2) Non-separable blends (luminosity/hue/saturation/color) fall back to source-over —
  //    use separable `screen` and bake brightness into the gradient stops.

  function syncAmbientPause() {
    root.classList.toggle("is-ambient-paused", document.hidden);
  }

  function prefersReducedMotion() {
    return reducedMotionQuery.matches;
  }

  function shouldAnimate() {
    return Boolean(
      context
      && root.classList.contains("is-open")
      && !root.classList.contains("is-dragging")
      && !root.classList.contains("is-ambient-paused")
      && root.getAttribute("data-mode") !== "queue"
      && !prefersReducedMotion()
    );
  }

  function ensureLoop() {
    if (frameId || !context) return;
    frameId = window.requestAnimationFrame(tick);
  }

  function paint(now = performance.now()) {
    if (!context) return;

    if (crossfading) {
      const progress = Math.min(1, (now - crossfadeStartedAt) / CROSSFADE_MS);
      displayColors = fromColors.map((from, index) => lerpColor(from, toColors[index], progress));
      if (progress >= 1) crossfading = false;
    }

    const elapsed = now - startTime;
    const stampMin = Math.min(STAMP_WIDTH, STAMP_HEIGHT);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.fillStyle = BASE_FILL;
    context.fillRect(0, 0, STAMP_WIDTH, STAMP_HEIGHT);

    for (let index = 0; index < BLOBS.length; index += 1) {
      const blob = BLOBS[index];
      const color = displayColors[index] || displayColors[0];
      const driftX = Math.sin((elapsed * blob.spin * 2.4) + blob.phase) * blob.orbit;
      const driftY = Math.cos((elapsed * blob.spin * 1.8) + blob.phase) * blob.orbit;
      const cx = (blob.x + driftX) * STAMP_WIDTH;
      const cy = (blob.y + driftY) * STAMP_HEIGHT;
      // Gradients end at their radius; blur bled ~3× past the edge. Expand so tails fuse.
      const glowRadius = blob.radius * stampMin * GLOW_SCALE;

      context.save();
      context.globalCompositeOperation = "screen";
      context.translate(cx, cy);
      context.rotate(elapsed * blob.spin);
      context.fillStyle = createSoftDiscGradient(context, color, glowRadius);
      context.beginPath();
      context.arc(0, 0, glowRadius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    context.globalCompositeOperation = "source-over";
  }

  function tick(now) {
    frameId = 0;
    const animate = shouldAnimate();
    if (!animate && !crossfading) return;

    if (now - lastPaintAt >= FRAME_MS) {
      lastPaintAt = now;
      paint(now);
    }

    if (shouldAnimate() || crossfading) {
      frameId = window.requestAnimationFrame(tick);
    }
  }

  function beginCrossfade(palette) {
    fromColors = displayColors.map((color) => ({ ...color }));
    toColors = palette.map(parseColor);
    crossfadeStartedAt = performance.now();
    crossfading = true;
    if (!shouldAnimate()) paint(crossfadeStartedAt);
    else ensureLoop();
  }

  async function setCover(coverUrl) {
    if (!coverUrl || coverUrl === activeCoverUrl) return;

    activeCoverUrl = coverUrl;
    const version = ++requestVersion;
    let palette = paletteCache.get(coverUrl);

    if (!palette) {
      palette = getCuratedPalette(coverUrl);
      if (!palette) {
        try {
          palette = await extractCoverPalette(coverUrl);
        } catch {
          palette = CURATED_PALETTES.default;
        }
      }
      paletteCache.set(coverUrl, palette);
    }

    if (version !== requestVersion) return;
    beginCrossfade(palette);
  }

  function onAmbientStateChange() {
    syncAmbientPause();
    if (shouldAnimate() || crossfading) ensureLoop();
  }

  syncAmbientPause();
  document.addEventListener("visibilitychange", onAmbientStateChange);
  reducedMotionQuery.addEventListener?.("change", () => {
    if (!shouldAnimate()) paint(performance.now());
    else ensureLoop();
  });

  const stateObserver = new MutationObserver(onAmbientStateChange);
  stateObserver.observe(root, {
    attributes: true,
    attributeFilter: ["class", "data-mode"],
  });

  if (stage) stage.hidden = !context;
  paint(performance.now());
  if (shouldAnimate()) ensureLoop();

  return {
    setCover,
    destroy() {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
      document.removeEventListener("visibilitychange", onAmbientStateChange);
      stateObserver.disconnect();
    },
  };
}

/**
 * Soft disc falloff sized for blur-like bleed.
 * Center alpha is kept modest so 2.75× radius + screen doesn't blow out.
 */
function createSoftDiscGradient(context, color, radius) {
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
  gradient.addColorStop(0, toRgba(color, 0.62));
  gradient.addColorStop(0.18, toRgba(color, 0.48));
  gradient.addColorStop(0.3, toRgba(color, 0.34));
  gradient.addColorStop(0.48, toRgba(color, 0.18));
  gradient.addColorStop(0.65, toRgba(color, 0.07));
  gradient.addColorStop(0.78, toRgba(color, 0.02));
  gradient.addColorStop(1, toRgba(color, 0));
  return gradient;
}

function toRgba({ red, green, blue }, alpha) {
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function parseColor(value) {
  const text = String(value).trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3
      ? raw.split("").map((part) => part + part).join("")
      : raw;
    return {
      red: Number.parseInt(full.slice(0, 2), 16),
      green: Number.parseInt(full.slice(2, 4), 16),
      blue: Number.parseInt(full.slice(4, 6), 16),
    };
  }

  const rgb = text.match(/rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)/i);
  if (rgb) {
    return {
      red: Math.round(Number(rgb[1])),
      green: Math.round(Number(rgb[2])),
      blue: Math.round(Number(rgb[3])),
    };
  }

  return { red: 100, green: 116, blue: 139 };
}

function lerpColor(from, to, progress) {
  return {
    red: Math.round(from.red + ((to.red - from.red) * progress)),
    green: Math.round(from.green + ((to.green - from.green) * progress)),
    blue: Math.round(from.blue + ((to.blue - from.blue) * progress)),
  };
}

async function extractCoverPalette(coverUrl) {
  const image = await loadImage(coverUrl);
  const canvas = document.createElement("canvas");
  const size = 48;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");

  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const colorBins = new Map();

  for (let index = 0; index < data.length; index += 16) {
    const alpha = data[index + 3];
    if (alpha < 200) continue;

    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const { hue, saturation, lightness } = rgbToHsl(red, green, blue);

    if (lightness < 0.1 || lightness > 0.9 || saturation < 0.28) continue;

    const key = [
      Math.round(hue / 24),
      Math.round(saturation * 4),
      Math.round(lightness * 5),
    ].join("-");
    const weight = saturation ** 2 * (lightness > 0.18 && lightness < 0.78 ? 1 : 0.65);
    const bin = colorBins.get(key) || { red: 0, green: 0, blue: 0, weight: 0, score: 0 };
    bin.red += red * weight;
    bin.green += green * weight;
    bin.blue += blue * weight;
    bin.weight += weight;
    bin.score += weight;
    colorBins.set(key, bin);
  }

  const candidates = [...colorBins.values()]
    .sort((left, right) => right.score - left.score)
    .map((color) => normalizeAmbientColor({
      red: color.red / color.weight,
      green: color.green / color.weight,
      blue: color.blue / color.weight,
    }));

  if (!candidates.length) throw new Error("No usable colors found in cover art.");

  const palette = [];
  for (const candidate of candidates) {
    if (palette.every((color) => colorDistance(color, candidate) > 62)) {
      palette.push(candidate);
    }
    if (palette.length === 3) break;
  }

  while (palette.length < 3) {
    palette.push(shiftHue(palette[0], palette.length * 46));
  }

  return palette.map(toCssColor);
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load cover art: ${source}`));
    image.src = source;
  });
}

function getCuratedPalette(coverUrl) {
  const name = String(coverUrl).toLowerCase();
  const key = ["anthology", "old", "new", "paytch"].find((kind) => name.includes(kind));
  return key ? CURATED_PALETTES[key] : null;
}

function normalizeAmbientColor({ red, green, blue }) {
  const { hue, saturation, lightness } = rgbToHsl(red, green, blue);
  return hslToRgb(
    hue,
    clamp(saturation * 1.08, 0.38, 0.8),
    clamp(lightness, 0.34, 0.62),
  );
}

function shiftHue(color, degrees) {
  const { hue, saturation, lightness } = rgbToHsl(color.red, color.green, color.blue);
  return hslToRgb((hue + degrees) % 360, saturation, lightness);
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;

  if (delta) {
    saturation = delta / (1 - Math.abs((2 * lightness) - 1));
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * (((b - r) / delta) + 2);
    else hue = 60 * (((r - g) / delta) + 4);
  }

  return {
    hue: hue < 0 ? hue + 360 : hue,
    saturation,
    lightness,
  };
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - (chroma / 2);
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) [red, green, blue] = [chroma, x, 0];
  else if (hue < 120) [red, green, blue] = [x, chroma, 0];
  else if (hue < 180) [red, green, blue] = [0, chroma, x];
  else if (hue < 240) [red, green, blue] = [0, x, chroma];
  else if (hue < 300) [red, green, blue] = [x, 0, chroma];
  else [red, green, blue] = [chroma, 0, x];

  return {
    red: Math.round((red + match) * 255),
    green: Math.round((green + match) * 255),
    blue: Math.round((blue + match) * 255),
  };
}

function colorDistance(left, right) {
  return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue);
}

function toCssColor({ red, green, blue }) {
  return `rgb(${red} ${green} ${blue})`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
