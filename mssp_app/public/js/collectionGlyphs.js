const COLLECTION_GLYPH_MARKUP = {
  old: `<g transform="rotate(25 18 10)"><path fill="currentColor" d="M15 6 A 5.5 5.5 0 1 1 15 14 A 4 4 0 1 0 15 6 Z"></path></g>`,
  // Official Patreon mark path (1080 canvas), scaled into the shared 36×20 glyph box.
  paytch: `<g transform="translate(18 10) scale(0.0122) translate(-540 -540)" fill="currentColor"><path fill-rule="nonzero" d="M1033.05 324.45c-.19-137.9-107.59-250.92-233.6-291.7-156.48-50.64-362.86-43.3-512.28 27.2-181.1 85.46-237.99 272.66-240.11 459.36-1.74 153.5 13.58 557.79 241.62 560.67 169.44 2.15 194.67-216.18 273.07-321.33 55.78-74.81 127.6-95.94 216.01-117.82 151.95-37.61 255.51-157.53 255.29-316.38z"/></g>`,
  new: `<g transform="rotate(-25 18 10)"><path fill="currentColor" d="M21 6 A 5.5 5.5 0 1 0 21 14 A 4 4 0 1 1 21 6 Z"></path></g>`,
  cancelled: `<image href="./assets/icons/hand-from-ground.svg" x="6" y="0" width="24" height="20" preserveAspectRatio="xMidYMid meet"></image>`,
};

export function renderCollectionGlyphSvg(kind, className = "", viewBox = "0 0 36 20") {
  const markup = COLLECTION_GLYPH_MARKUP[kind] || COLLECTION_GLYPH_MARKUP.old;
  const classAttr = className ? ` class="${className}"` : "";
  return `<svg${classAttr} viewBox="${viewBox}" aria-hidden="true" focusable="false">${markup}</svg>`;
}

export function renderCollectionCardGlyph(kind) {
  return `<span class="collection-card__glyph-frame">${renderCollectionGlyphSvg(kind, "collection-card__glyph")}</span>`;
}

export function renderCalCellGlyph(kind, positionClass, accent) {
  return `<span class="cal-cell__glyph ${positionClass}" style="--glyph-color: ${accent}">${renderCollectionGlyphSvg(kind, "cal-cell__glyph__svg")}</span>`;
}
