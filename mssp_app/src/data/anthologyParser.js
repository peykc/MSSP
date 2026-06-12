const fs = require("node:fs");
const path = require("node:path");
const {
  findHeaderIndexes,
  isMarkdownTableLine,
  isSeparatorRow,
  splitMarkdownRow,
} = require("../utils/markdownTable");
const { deriveEpisodeFields } = require("./episodeDeriver");
const { enrichEpisodesWithMetadata, stripMediaExtension } = require("./episodeMetadata");

const REQUIRED_COLUMNS = ["date", "type", "paytch", "episode", "title"];
const FILENAME_PATTERN = /^(?<date>\d{4}-\d{2}-\d{2})\s+(?<type>MSSPOT|MSSP)(?:\s+(?<paytch>PAYTCH))?\s+Ep\.\s+(?<episode>EX|\d+(?:\.\d+)?)\s+-\s+(?<title>.+)$/;

function parseAnthology(filePath, { metadataPath } = {}) {
  const parsed = path.extname(filePath).toLowerCase() === ".txt"
    ? parseSourceList(filePath)
    : parseMarkdown(filePath);
  const enriched = enrichEpisodesWithMetadata(parsed.episodes, metadataPath);

  return {
    ...parsed,
    episodes: enriched.episodes,
    metadataDiagnostics: enriched.diagnostics,
  };
}

function parseSourceList(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const warnings = [];
  const episodes = [];

  for (const rawRow of lines) {
    const sourcePath = sanitizeSourcePath(rawRow);
    const filename = path.win32.basename(sourcePath);
    const filenameStem = stripMediaExtension(filename);
    const match = FILENAME_PATTERN.exec(filenameStem);
    if (!match) {
      warnings.push(`Skipped source filename that did not match the expected MSSP pattern: ${filename}`);
      continue;
    }

    const row = {
      date: match.groups.date,
      type: match.groups.type,
      paytch: match.groups.paytch || "",
      episode: match.groups.episode,
      title: match.groups.title,
      filename,
      filenameStem,
      sourcePath,
    };
    episodes.push({
      ...deriveEpisodeFields(row, episodes.length + 1),
      rawRow: sourcePath,
    });
  }

  return {
    episodes,
    warnings,
    skippedRows: lines.length - episodes.length,
    sourceFile: filePath,
  };
}

function parseMarkdown(filePath) {
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
      warnings.push(`Skipped row at markdown table line ${lineIndex + 1}`);
      continue;
    }

    const row = {
      date: cells[headerIndexes.date] || "",
      type: cells[headerIndexes.type] || "",
      paytch: cells[headerIndexes.paytch] || "",
      episode: cells[headerIndexes.episode] || "",
      title: cells[headerIndexes.title] || "",
    };
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

function sanitizeSourcePath(rawPath) {
  let value = String(rawPath || "").trim().replace(/^"(.*)"$/, "$1").replace(/\//g, "\\");
  const archiveRoot = "\\Matt and Shane's Secret Podcast\\";
  const archiveIndex = value.indexOf(archiveRoot);
  if (archiveIndex >= 0) value = value.slice(archiveIndex);
  if (/^[A-Za-z]:\\/.test(value)) value = `\\${path.win32.basename(value)}`;
  if (!value.startsWith("\\")) value = `\\${value}`;
  return value;
}

module.exports = {
  parseAnthology,
  sanitizeSourcePath,
};
