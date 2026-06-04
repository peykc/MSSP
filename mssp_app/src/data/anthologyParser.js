const fs = require("node:fs");
const {
  findHeaderIndexes,
  isMarkdownTableLine,
  isSeparatorRow,
  splitMarkdownRow,
} = require("../utils/markdownTable");
const { deriveEpisodeFields } = require("./episodeDeriver");

const REQUIRED_COLUMNS = ["date", "type", "paytch", "episode", "title"];

function parseAnthology(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const tableLines = text.split(/\r?\n/).filter(isMarkdownTableLine);
  const warnings = [];

  if (tableLines.length === 0) {
    throw new Error(`Anthology markdown has no table rows: ${filePath}`);
  }

  const headers = splitMarkdownRow(tableLines[0]);
  const headerIndexes = findHeaderIndexes(headers);
  const missingColumns = REQUIRED_COLUMNS.filter((column) => headerIndexes[column] < 0);
  if (missingColumns.length > 0) {
    throw new Error(`Anthology markdown is missing required columns: ${missingColumns.join(", ")}`);
  }

  const episodes = [];
  let skippedRows = 0;

  for (let lineIndex = 1; lineIndex < tableLines.length; lineIndex += 1) {
    const rawRow = tableLines[lineIndex];
    if (isSeparatorRow(rawRow)) continue;

    const cells = splitMarkdownRow(rawRow);
    if (cells.length < headers.length) {
      skippedRows += 1;
      warnings.push(`Skipped row at markdown table line ${lineIndex + 1}: expected ${headers.length} cells, got ${cells.length}`);
      continue;
    }

    const row = {
      date: cells[headerIndexes.date] || "",
      type: cells[headerIndexes.type] || "",
      paytch: cells[headerIndexes.paytch] || "",
      episode: cells[headerIndexes.episode] || "",
      title: cells[headerIndexes.title] || "",
    };

    const blankFields = ["date", "type", "episode", "title"].filter((field) => !String(row[field] || "").trim());
    if (blankFields.length > 0) {
      warnings.push(`Row ${episodes.length + 1} has blank ${blankFields.join(", ")} field(s)`);
    }

    episodes.push({
      ...deriveEpisodeFields(row, episodes.length + 1),
      rawRow,
    });
  }

  return {
    episodes,
    warnings,
    skippedRows,
    sourceFile: filePath,
  };
}

module.exports = {
  parseAnthology,
};
