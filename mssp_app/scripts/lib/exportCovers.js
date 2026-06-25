const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { COVERS, PUBLIC_DIR } = require("../../src/config/paths");

const SQUARE_COVER_SIZE = 768;
const HERO_COVER = { width: 1536, height: 960 };
const WEBP_OPTIONS = { quality: 84, effort: 4 };

async function exportCoverAssets() {
  const coversDir = path.join(PUBLIC_DIR, "assets", "covers");
  fs.mkdirSync(coversDir, { recursive: true });

  for (const [kind, cover] of Object.entries(COVERS)) {
    await writeCoverWebp(
      cover.file,
      path.join(coversDir, `${kind}.webp`),
      { layout: kind === "anthology" ? "hero" : "square" },
    );
    if (cover.hoverFile) {
      await writeCoverWebp(
        cover.hoverFile,
        path.join(coversDir, `${kind}-hover.webp`),
        { layout: "hero" },
      );
    }
  }
}

async function writeCoverWebp(sourceFile, destFile, { layout = "square" } = {}) {
  let pipeline = sharp(sourceFile).rotate();
  if (layout === "square") {
    pipeline = pipeline.resize(SQUARE_COVER_SIZE, SQUARE_COVER_SIZE, {
      fit: "cover",
      position: "centre",
    });
  } else {
    pipeline = pipeline.resize(HERO_COVER.width, HERO_COVER.height, {
      fit: "cover",
      position: "centre",
    });
  }
  await pipeline.webp(WEBP_OPTIONS).toFile(destFile);
}

function staticCoverUrl(kind) {
  return `./assets/covers/${kind}.webp`;
}

module.exports = {
  exportCoverAssets,
  staticCoverUrl,
};
