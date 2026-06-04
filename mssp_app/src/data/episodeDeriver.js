const { normalizeKeyPart, normalizeSearchText } = require("../utils/normalize");

function deriveEpisodeFields(row, globalIndex) {
  const series = String(row.type || "").trim().toUpperCase();
  const paytchLabel = String(row.paytch || "").trim();
  const isPaytch = paytchLabel.toUpperCase() === "PAYTCH";
  const episodeCode = String(row.episode || "").trim();
  const title = String(row.title || "").trim();

  let collectionKind;
  if (isPaytch) collectionKind = "paytch";
  else if (series === "MSSPOT") collectionKind = "old";
  else collectionKind = "new";

  const episodeKey = [
    "global",
    String(globalIndex).padStart(6, "0"),
    normalizeKeyPart(series),
    isPaytch ? "paytch" : "public",
    normalizeKeyPart(episodeCode || "extra"),
    normalizeKeyPart(title || "untitled"),
  ].filter(Boolean).join("-");

  const searchableText = normalizeSearchText([
    row.date,
    series,
    isPaytch ? "PAYTCH Patreon" : "Public",
    episodeCode,
    title,
    collectionKind,
  ]);

  return {
    globalIndex,
    episodeKey,
    date: String(row.date || "").trim(),
    series,
    isPaytch,
    episodeCode,
    title,
    collectionKind,
    coverKind: collectionKind,
    searchableText,
  };
}

module.exports = {
  deriveEpisodeFields,
};
