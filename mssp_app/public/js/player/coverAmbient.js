const CURATED_PALETTES = Object.freeze({
  anthology: ["#6e9b8f", "#5d7895", "#a08f6f"],
  old: ["#6c94a6", "#718495", "#a89779"],
  new: ["#bd8355", "#956957", "#867651"],
  paytch: ["#f96854", "#c45a48", "#765f4f"],
  default: ["#64748b", "#855f76", "#6a8067"],
});

export function createCoverAmbient({ root }) {
  const layers = [...root.querySelectorAll(".full-player__ambient-layer")];
  const paletteCache = new Map();
  let activeLayerIndex = Math.max(0, layers.findIndex((layer) => layer.classList.contains("is-active")));
  let activeCoverUrl = "";
  let requestVersion = 0;

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
    applyPalette(palette);
  }

  function applyPalette(palette) {
    if (!layers.length) return;

    const nextLayerIndex = layers.length > 1
      ? (activeLayerIndex + 1) % layers.length
      : activeLayerIndex;
    const nextLayer = layers[nextLayerIndex];
    const [first, second, third] = palette;

    nextLayer.style.setProperty("--ambient-one", first);
    nextLayer.style.setProperty("--ambient-two", second);
    nextLayer.style.setProperty("--ambient-three", third);

    if (nextLayerIndex === activeLayerIndex) return;
    nextLayer.classList.add("is-active");
    layers[activeLayerIndex].classList.remove("is-active");
    activeLayerIndex = nextLayerIndex;
  }

  return { setCover };
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
  const normalized = hslToRgb(
    hue,
    clamp(saturation * 1.08, 0.38, 0.8),
    clamp(lightness, 0.34, 0.62),
  );
  return normalized;
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
