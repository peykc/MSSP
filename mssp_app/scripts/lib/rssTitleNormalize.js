const { normalizeKeyPart } = require("../../src/utils/normalize");

function normalizeMatchTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/&amp;/g, "and")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEpisodeNumber(title) {
  const text = String(title || "");
  const patterns = [
    /\bep\.?\s*(\d+(?:\.\d+)?)\b/i,
    /\bepisode\s*(\d+(?:\.\d+)?)\b/i,
    /#\s*(\d+(?:\.\d+)?)\b/,
    /^\s*(\d+(?:\.\d+)?)\s*[-:]/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function titleTokens(value) {
  return normalizeMatchTitle(value).split(/\s+/).filter(Boolean);
}

function tokenOverlapRatio(left, right) {
  const leftTokens = new Set(titleTokens(left));
  const rightTokens = new Set(titleTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function titleContainsOther(left, right) {
  const leftNorm = normalizeMatchTitle(left);
  const rightNorm = normalizeMatchTitle(right);
  if (!leftNorm || !rightNorm) return false;
  if (leftNorm === rightNorm) return false;
  return leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm);
}

function normalizeRssTitle(title) {
  return normalizeKeyPart(title).replace(/-/g, " ");
}

module.exports = {
  extractEpisodeNumber,
  normalizeMatchTitle,
  normalizeRssTitle,
  titleContainsOther,
  tokenOverlapRatio,
};
