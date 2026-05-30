const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "mssp.sqlite");
const PORT = Number(process.env.PORT || 5177);

const COLLECTIONS = [
  {
    id: "new",
    name: "The New Testament",
    shortName: "New Test",
    markdown: path.join(ROOT, "The New Testament", "MSSP - The New Testament.md"),
    coverFile: path.join(ROOT, "The New Testament", "cover.jpg"),
    accent: "#c79457",
  },
  {
    id: "old",
    name: "The Old Testament",
    shortName: "Old Test",
    markdown: path.join(ROOT, "The Old Testament", "MSSP - The Old Testement.md"),
    coverFile: path.join(ROOT, "The Old Testament", "cover.jpg"),
    accent: "#8da1b8",
  },
  {
    id: "paytch",
    name: "The Paytch",
    shortName: "Paytch",
    markdown: path.join(ROOT, "The Paytch", "MSSP - The Paytch.md"),
    coverFile: path.join(ROOT, "The Paytch", "cover.jpg"),
    accent: "#db855f",
  },
  {
    id: "anthology",
    name: "The Anthology",
    shortName: "Anthology",
    markdown: path.join(ROOT, "The Anthology", "MSSP - The Anthology.md"),
    coverFile: path.join(ROOT, "The Anthology", "cover.jpg"),
    accent: "#7fc1ad",
  },
];

function parseMarkdownTable(filePath, sourceCollection) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) return [];

  const headers = splitRow(lines[0]).map((header) => normalizeHeader(header));
  return lines.slice(2).flatMap((line, index) => {
    const cells = splitRow(line);
    if (cells.length < 4) return [];

    const row = Object.fromEntries(headers.map((header, i) => [header, (cells[i] || "").trim()]));
    const type = row.type || row.mssp || "";
    const paytch = row.paytch || "";
    const title = row.episode_title || "";
    const tags = [type, paytch, title, sourceCollection].filter(Boolean).join(" ");

    return [{
      sourceCollection,
      rowNumber: index + 1,
      date: row.date || "",
      type,
      paytch,
      episode: row.ep || "",
      title,
      coverKind: determineCoverKind({ type, paytch, title, sourceCollection, tags }),
      tags,
      rawLine: line,
    }];
  });
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((part) => part.trim());
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/\./g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function determineCoverKind(entry) {
  const tagText = `${entry.tags} ${entry.paytch} ${entry.title}`.toUpperCase();
  if (tagText.includes("PAYTCH") || tagText.includes("PATREON")) return "paytch";
  if ((entry.type || "").toUpperCase() === "MSSPOT") return "old";
  return "new";
}

function buildDatabase() {
  for (const filePath of [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      source_collection TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      date TEXT,
      type TEXT,
      paytch TEXT,
      episode TEXT,
      title TEXT NOT NULL,
      cover_kind TEXT NOT NULL,
      tags TEXT,
      raw_line TEXT
    );
    CREATE INDEX idx_episodes_source ON episodes(source_collection, date, id);
    CREATE INDEX idx_episodes_cover ON episodes(cover_kind);
    CREATE INDEX idx_episodes_search ON episodes(title, episode, type, paytch);
  `);

  const insert = db.prepare(`
    INSERT INTO episodes (
      source_collection, row_number, date, type, paytch, episode, title, cover_kind, tags, raw_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let total = 0;
  db.exec("BEGIN TRANSACTION");
  for (const collection of COLLECTIONS) {
    if (!fs.existsSync(collection.markdown)) continue;
    const rows = parseMarkdownTable(collection.markdown, collection.id);
    for (const row of rows) {
      insert.run(
        row.sourceCollection,
        row.rowNumber,
        row.date,
        row.type,
        row.paytch,
        row.episode,
        row.title,
        row.coverKind,
        row.tags,
        row.rawLine,
      );
    }
    total += rows.length;
  }
  db.exec("COMMIT");
  return { db, total };
}

const { db, total } = buildDatabase();

function sendJson(response, body, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  });
}

function getCollectionStats() {
  const stats = db.prepare(`
    SELECT source_collection AS collection, COUNT(*) AS count, MIN(date) AS start_date, MAX(date) AS end_date
    FROM episodes
    GROUP BY source_collection
  `).all();
  return Object.fromEntries(stats.map((row) => [row.collection, row]));
}

function handleApi(requestUrl, response) {
  if (requestUrl.pathname === "/api/collections") {
    const stats = getCollectionStats();
    sendJson(response, {
      total,
      collections: COLLECTIONS.map((collection) => ({
        id: collection.id,
        name: collection.name,
        shortName: collection.shortName,
        coverUrl: `/covers/${collection.id}`,
        accent: collection.accent,
        count: stats[collection.id]?.count || 0,
        startDate: stats[collection.id]?.start_date || "",
        endDate: stats[collection.id]?.end_date || "",
      })),
    });
    return;
  }

  if (requestUrl.pathname === "/api/episodes") {
    const collection = requestUrl.searchParams.get("collection") || "anthology";
    const query = (requestUrl.searchParams.get("q") || "").trim();
    const allowed = new Set(COLLECTIONS.map((item) => item.id));
    if (!allowed.has(collection)) {
      sendJson(response, { error: "Unknown collection" }, 400);
      return;
    }

    const where = ["source_collection = ?"];
    const params = [collection];
    if (query) {
      where.push("(title LIKE ? OR episode LIKE ? OR type LIKE ? OR paytch LIKE ? OR date LIKE ?)");
      const like = `%${query}%`;
      params.push(like, like, like, like, like);
    }

    const whereSql = where.join(" AND ");
    const episodes = db.prepare(`
      SELECT id, source_collection AS sourceCollection, date, type, paytch, episode, title,
             cover_kind AS coverKind, tags, raw_line AS rawLine
      FROM episodes
      WHERE ${whereSql}
      ORDER BY date ASC, id ASC
    `).all(...params).map((episode) => ({
      ...episode,
      coverUrl: `/covers/${episode.coverKind}`,
      paytch: episode.paytch || "",
    }));
    sendJson(response, { collection, count: episodes.length, episodes });
    return;
  }

  sendJson(response, { error: "Not found" }, 404);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(requestUrl, response);
    return;
  }

  if (requestUrl.pathname.startsWith("/covers/")) {
    const id = requestUrl.pathname.split("/").pop();
    const collection = COLLECTIONS.find((item) => item.id === id);
    if (!collection) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    sendFile(response, collection.coverFile, "image/jpeg");
    return;
  }

  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  sendFile(response, filePath, contentTypeFor(filePath));
});

server.listen(PORT, () => {
  console.log(`MSSP Anthology is indexing ${total} rows into ${DB_PATH}`);
  console.log(`Open http://localhost:${PORT}`);
});
