const { normalizeSearchText } = require("../utils/normalize");

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

  const fallbackFilenameStem = [
    String(row.date || "").trim(),
    `${series}${isPaytch ? " PAYTCH" : ""}`,
    `Ep. ${episodeCode || "EX"}`,
    `- ${title}`,
  ].filter(Boolean).join(" ");
  const filenameStem = String(row.filenameStem || fallbackFilenameStem).trim();
  const filename = String(row.filename || `${filenameStem}.mp3`).trim();
  const sourcePath = String(row.sourcePath || "").trim();
  const episodeKey = filenameStem;

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
    filename,
    filenameStem,
    sourcePath,
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
