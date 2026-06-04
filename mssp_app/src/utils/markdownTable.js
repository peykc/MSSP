const { normalizeHeader } = require("./normalize");

function splitMarkdownRow(line) {
  const trimmed = String(line || "").trim();
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableLine(line) {
  return String(line || "").trim().startsWith("|");
}

function isSeparatorRow(line) {
  const cells = splitMarkdownRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function findHeaderIndexes(headers) {
  const normalized = headers.map((header) => normalizeHeader(header));
  const findAny = (names) => normalized.findIndex((header) => names.includes(header));

  return {
    date: findAny(["date"]),
    type: findAny(["type", "mssp_type", "mssp"]),
    paytch: findAny(["paytch"]),
    episode: findAny(["ep", "episode", "ep_count", "episode_count"]),
    title: findAny(["episode_title", "title"]),
  };
}

module.exports = {
  splitMarkdownRow,
  isMarkdownTableLine,
  isSeparatorRow,
  findHeaderIndexes,
};
