#!/usr/bin/env node
/**
 * One-command episode update path.
 *
 * 1. Split Trinity collections (organizefilepath.py)
 * 2. Sync expected counts
 * 3. Export episodes + Megaphone sources
 * 4. Audit PAYTCH against PATREON_RSS_URL (or --patreon-feed)
 * 5. Regenerate signals catalog
 * 6. Print leftovers that still need human hands
 *
 * Usage:
 *   node tools/run_update.mjs
 *   node tools/run_update.mjs --patreon-feed path/to/feed.xml
 *   PATREON_RSS_URL=... node tools/run_update.mjs
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "mssp_app");
const SIGNALS = path.join(ROOT, "mssp_signals_worker");
const TRINITY_TXT = path.join(ROOT, "data", "The Holy Trinity", "MSSP - The Holy Trinity.txt");
const COLLECTIONS_JS = path.join(APP, "src", "config", "collections.js");
const R2_SOURCES_JS = path.join(APP, "scripts", "lib", "buildR2Sources.js");
const EPISODES_JSON = path.join(APP, "public", "data", "episodes.json");
const HEALTH_JSON = path.join(APP, "public", "data", "health.json");
const SOURCE_REPORT = path.join(APP, "public", "data", "source-match-report.json");
const PAYTCH_REPORT = path.join(APP, "public", "data", "paytch-match-report.json");
const PAYTCH_OVERRIDES = path.join(APP, "public", "data", "patreon-rss-overrides.json");

const FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})\s+(MSSPOT|MSSP)(?:\s+(PAYTCH))?\s+Ep\.\s+(EX|\d+(?:\.\d+)?)\s+-\s+(.+)\.(?:mp3|m4a|mp4|wav|flac|aac|ogg|opus)$/i;

const args = new Set(process.argv.slice(2));
const patreonFeedArg = readFlagValue("--patreon-feed");
const skipOrganize = args.has("--skip-organize");
const skipExport = args.has("--skip-export");
const skipCatalog = args.has("--skip-catalog");
const skipPatreon = args.has("--skip-patreon");

const requireFromApp = createRequire(path.join(APP, "package.json"));

main().catch((error) => {
  console.error(`\n[run_update] FAILED: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  console.log("[run_update] MSSP update pipeline\n");

  if (!skipOrganize) {
    step("1/5 Split collections");
    run("python", [path.join(ROOT, "data", "organizefilepath.py")], ROOT);
  } else {
    console.log("1/5 Split collections (skipped)\n");
  }

  step("2/5 Sync expected counts");
  const counts = countTrinity(TRINITY_TXT);
  syncExpectedCounts(counts);
  syncExpectedR2Count(counts.old);
  console.log(
    `  anthology=${counts.anthology} old=${counts.old} new=${counts.new} paytch=${counts.paytch}\n`,
  );

  if (!skipExport) {
    step("3/5 Export episodes + Megaphone sources");
    run("npm", ["run", "export:all"], APP);
  } else {
    console.log("3/5 Export (skipped)\n");
  }

  let paytchReport = null;
  if (!skipPatreon) {
    step("4/5 Audit PAYTCH against Patreon feed");
    paytchReport = await auditPaytch();
  } else {
    console.log("4/5 PAYTCH audit (skipped)\n");
  }

  if (!skipCatalog) {
    step("5/5 Regenerate signals catalog");
    run("npm", ["run", "catalog:generate"], SIGNALS);
  } else {
    console.log("5/5 Signals catalog (skipped)\n");
  }

  printLeftovers(paytchReport);
}

function step(label) {
  console.log(`==> ${label}`);
}

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] || null;
}

function run(command, commandArgs, cwd) {
  // Never use shell:true — paths with spaces (this repo) get split on Windows.
  const bin = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(bin, commandArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited ${result.status}`);
  }
}

function countTrinity(txtPath) {
  if (!existsSync(txtPath)) throw new Error(`Missing Trinity list: ${txtPath}`);
  const counts = { anthology: 0, old: 0, new: 0, paytch: 0 };
  for (const line of readFileSync(txtPath, "utf8").split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^"|"$/g, "");
    if (!cleaned) continue;
    const filename = cleaned.split("\\").pop();
    const match = FILENAME_RE.exec(filename);
    if (!match) continue;
    counts.anthology += 1;
    const isPaytch = Boolean(match[3]);
    const showType = match[2].toUpperCase();
    if (isPaytch) counts.paytch += 1;
    else if (showType === "MSSPOT") counts.old += 1;
    else counts.new += 1;
  }
  if (!counts.anthology) throw new Error("Trinity txt parsed zero episodes");
  return counts;
}

function syncExpectedCounts(counts) {
  const current = readFileSync(COLLECTIONS_JS, "utf8");
  const nextBlock = `const EXPECTED_COUNTS = {
  anthology: ${counts.anthology},
  old: ${counts.old},
  new: ${counts.new},
  paytch: ${counts.paytch},
};`;
  if (!/const EXPECTED_COUNTS = \{[\s\S]*?\};/.test(current)) {
    throw new Error(`Could not find EXPECTED_COUNTS in ${COLLECTIONS_JS}`);
  }
  const updated = current.replace(/const EXPECTED_COUNTS = \{[\s\S]*?\};/, nextBlock);
  if (updated !== current) {
    writeFileSync(COLLECTIONS_JS, updated, "utf8");
    console.log("  updated mssp_app/src/config/collections.js");
  } else {
    console.log("  expected counts already current");
  }
}

function syncExpectedR2Count(oldCount) {
  const current = readFileSync(R2_SOURCES_JS, "utf8");
  const updated = current.replace(
    /const EXPECTED_R2_COUNT = \d+;/,
    `const EXPECTED_R2_COUNT = ${oldCount};`,
  );
  if (updated === current) {
    if (!current.includes(`const EXPECTED_R2_COUNT = ${oldCount};`)) {
      throw new Error(`Could not sync EXPECTED_R2_COUNT in ${R2_SOURCES_JS}`);
    }
    console.log("  expected R2 count already current");
    return;
  }
  writeFileSync(R2_SOURCES_JS, updated, "utf8");
  console.log("  updated mssp_app/scripts/lib/buildR2Sources.js");
}

async function auditPaytch() {
  const feedXml = await loadPatreonXml();
  if (!feedXml) {
    console.log("  no PATREON_RSS_URL / --patreon-feed — skipped\n");
    return null;
  }

  const { XMLParser } = requireFromApp("fast-xml-parser");
  const { matchPatreonSources } = await import(
    pathToFileURL(path.join(APP, "public", "js", "sources", "patreonRssMatcher.js")).href
  );
  const { addPatreonR2Sources, hasPatreonR2Source } = await import(
    pathToFileURL(path.join(APP, "public", "js", "sources", "patreonR2Sources.js")).href
  );

  const episodes = JSON.parse(readFileSync(EPISODES_JSON, "utf8")).episodes || [];
  const overridesPayload = existsSync(PAYTCH_OVERRIDES)
    ? JSON.parse(readFileSync(PAYTCH_OVERRIDES, "utf8"))
    : { matches: {} };
  const overrides = overridesPayload?.matches && typeof overridesPayload.matches === "object"
    ? overridesPayload.matches
    : {};

  const candidates = parsePatreonFeedXml(feedXml, XMLParser);
  const eligiblePaytch = episodes.filter((episode) => episode?.paytch === "PAYTCH");

  // Same rule as patreonRssSources.js: free feeds are a small fraction of catalog size.
  if (candidates.length > 0 && eligiblePaytch.length > 0 && candidates.length < eligiblePaytch.length * 0.25) {
    throw new Error(
      `Patreon feed looks public-only (${candidates.length} items vs ${eligiblePaytch.length} PAYTCH episodes)`,
    );
  }

  const rssEpisodes = episodes.filter((episode) => !hasPatreonR2Source(episode));
  const result = matchPatreonSources({ episodes: rssEpisodes, candidates, overrides });

  const matchedKeys = new Set(result.matches.map((match) => match.episode.episodeKey));
  const privateR2Sources = {};
  const privateR2Matched = addPatreonR2Sources(episodes, privateR2Sources);
  for (const key of Object.keys(privateR2Sources)) matchedKeys.add(key);

  const unmatchedEpisodes = eligiblePaytch
    .filter((episode) => !matchedKeys.has(episode.episodeKey))
    .map((episode) => ({
      episodeKey: episode.episodeKey,
      date: episode.date,
      episode: episode.episode,
      title: episode.title,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    note: "Audit only. No enclosure URLs are stored. Playback still uses each visitor's private RSS link.",
    summary: {
      eligibleEpisodes: eligiblePaytch.length,
      feedItems: candidates.length,
      matched: matchedKeys.size,
      automaticMatched: result.summary.automaticMatched,
      manualMatched: result.summary.manualMatched,
      privateR2Matched,
      unmatchedEpisodes: unmatchedEpisodes.length,
    },
    unmatchedEpisodes,
  };

  writeFileSync(PAYTCH_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `  PAYTCH ${report.summary.matched}/${report.summary.eligibleEpisodes} matched `
      + `(feed items=${report.summary.feedItems}, unmatched=${report.summary.unmatchedEpisodes})`,
  );
  console.log(`  wrote ${path.relative(ROOT, PAYTCH_REPORT)}\n`);
  return report;
}

async function loadPatreonXml() {
  if (patreonFeedArg) {
    const feedPath = path.resolve(patreonFeedArg);
    if (!existsSync(feedPath)) throw new Error(`Patreon feed file not found: ${feedPath}`);
    console.log(`  reading local feed file (${path.basename(feedPath)})`);
    return readFileSync(feedPath, "utf8");
  }

  const feedUrl = String(process.env.PATREON_RSS_URL || "").trim();
  if (!feedUrl) return null;

  console.log("  fetching PATREON_RSS_URL secret...");
  let response;
  try {
    response = await fetch(feedUrl, {
      headers: { "user-agent": "MSSP-run-update/1.0" },
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(`Patreon feed fetch failed: ${safeErrorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Patreon feed fetch HTTP ${response.status}`);
  }
  return response.text();
}

function parsePatreonFeedXml(xmlText, XMLParser) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep text nodes simple; Patreon RSS is flat enough.
  });
  const doc = parser.parse(String(xmlText || ""));
  const channel = doc?.rss?.channel || doc?.feed;
  if (!channel) throw new Error("Patreon feed XML missing rss/channel");

  const rawItems = channel.item ?? channel.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const seen = new Set();
  const candidates = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const enclosure = readEnclosure(item);
    if (!enclosure?.url) continue;
    const title = textOf(item.title);
    const pubDate = toIsoDate(textOf(item.pubDate) || textOf(item.published) || textOf(item.updated));
    const explicitGuid = textOf(item.guid) || textOf(item.id);
    const guid = explicitGuid || `${pubDate || "unknown"}:${normalizeTitle(title)}`;
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    candidates.push({
      guid: String(guid),
      title,
      pubDate,
      enclosureUrl: enclosure.url,
      mimeType: enclosure.type || "audio/mpeg",
    });
  }
  return candidates;
}

function readEnclosure(item) {
  const enclosure = item.enclosure;
  if (enclosure) {
    const nodes = Array.isArray(enclosure) ? enclosure : [enclosure];
    for (const node of nodes) {
      const url = node?.["@_url"] || node?.["@_href"] || (typeof node === "string" ? node : "");
      const type = node?.["@_type"] || "";
      if (url && (!type || String(type).startsWith("audio/") || /\.(mp3|m4a|aac|ogg|opus)(?:$|\?)/i.test(url))) {
        return { url: String(url), type: String(type || "") };
      }
    }
  }
  const link = item.link;
  if (link) {
    const nodes = Array.isArray(link) ? link : [link];
    for (const node of nodes) {
      if (typeof node === "string") continue;
      const rel = String(node?.["@_rel"] || "").toLowerCase();
      const url = node?.["@_href"] || node?.["@_url"];
      const type = node?.["@_type"] || "";
      if (rel === "enclosure" && url) return { url: String(url), type: String(type || "") };
    }
  }
  return null;
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    if (typeof value["#text"] === "string") return value["#text"].trim();
    if (typeof value["@_text"] === "string") return value["@_text"].trim();
  }
  return "";
}

function toIsoDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function printLeftovers(paytchReport) {
  console.log("\n========== MANUAL LEFTOVERS ==========");

  const todos = [];

  if (existsSync(HEALTH_JSON)) {
    const health = JSON.parse(readFileSync(HEALTH_JSON, "utf8"));
    for (const warning of health.warnings || []) {
      todos.push({ kind: "metadata", detail: warning });
    }
  }

  if (existsSync(SOURCE_REPORT)) {
    const report = JSON.parse(readFileSync(SOURCE_REPORT, "utf8"));
    for (const item of report.unmatchedEpisodes || []) {
      todos.push({
        kind: "megaphone-unmatched",
        detail: `${item.episodeKey} — ${item.reason || "no RSS match"}`,
      });
    }
    for (const item of report.lowConfidenceMatches || []) {
      todos.push({
        kind: "megaphone-low-confidence",
        detail: `${item.episodeKey} score=${item.score} ↔ ${item.rssTitle || item.candidateTitle || "?"}`,
      });
    }
  } else {
    todos.push({ kind: "megaphone", detail: "source-match-report.json missing — export may have failed" });
  }

  const paytch = paytchReport || (existsSync(PAYTCH_REPORT)
    ? JSON.parse(readFileSync(PAYTCH_REPORT, "utf8"))
    : null);
  if (paytch) {
    for (const item of paytch.unmatchedEpisodes || []) {
      todos.push({
        kind: "paytch-unmatched",
        detail: item.episodeKey,
      });
    }
  } else if (!skipPatreon) {
    todos.push({
      kind: "paytch",
      detail: "No Patreon audit ran. Set PATREON_RSS_URL or pass --patreon-feed.",
    });
  }

  todos.push({
    kind: "ads",
    detail: "Baked Megaphone promos still need local: cd mssp_audio_proxy && npm run cuts:align && npm run cuts:distill && npm run cuts:generate && npm run deploy",
  });
  todos.push({
    kind: "deploy-workers",
    detail: "If episode keys changed: commit signals catalog + deploy mssp_signals_worker. After promo cuts: deploy mssp_audio_proxy.",
  });

  if (!todos.length) {
    console.log("Nothing left. Ship it.");
  } else {
    const byKind = new Map();
    for (const todo of todos) {
      const list = byKind.get(todo.kind) || [];
      list.push(todo.detail);
      byKind.set(todo.kind, list);
    }
    for (const [kind, details] of byKind) {
      console.log(`\n[${kind}] (${details.length})`);
      for (const detail of details.slice(0, 40)) console.log(`  - ${detail}`);
      if (details.length > 40) console.log(`  ... +${details.length - 40} more`);
    }
  }

  console.log("\n======================================\n");
}

function safeErrorMessage(error) {
  const raw = error?.message || String(error);
  return raw
    .replace(/https:\/\/www\.patreon\.com\/rss\/[^\s)'"]+/gi, "https://www.patreon.com/rss/[redacted]")
    .replace(/([?&](?:auth|token|key|signature|session)=)[^&\s)'"]+/gi, "$1[redacted]");
}
