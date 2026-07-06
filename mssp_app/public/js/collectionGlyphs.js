const COLLECTION_GLYPH_MARKUP = {
  old: `<g transform="rotate(25 18 10)"><path fill="currentColor" d="M15 6 A 5.5 5.5 0 1 1 15 14 A 4 4 0 1 0 15 6 Z"></path></g>`,
  paytch: `<g fill="currentColor" stroke="none">
    <circle cx="18" cy="10" r="3.1"></circle>
    <g transform="translate(18 10)">
      <rect x="-0.8" y="-7.9" width="1.6" height="4.1" rx="0.35"></rect>
      <rect x="-0.8" y="3.8" width="1.6" height="4.1" rx="0.35"></rect>
      <g transform="rotate(45)">
        <rect x="-0.8" y="-7.9" width="1.6" height="4.1" rx="0.35"></rect>
        <rect x="-0.8" y="3.8" width="1.6" height="4.1" rx="0.35"></rect>
      </g>
      <g transform="rotate(90)">
        <rect x="-0.8" y="-7.9" width="1.6" height="4.1" rx="0.35"></rect>
        <rect x="-0.8" y="3.8" width="1.6" height="4.1" rx="0.35"></rect>
      </g>
      <g transform="rotate(135)">
        <rect x="-0.8" y="-7.9" width="1.6" height="4.1" rx="0.35"></rect>
        <rect x="-0.8" y="3.8" width="1.6" height="4.1" rx="0.35"></rect>
      </g>
    </g>
  </g>`,
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
