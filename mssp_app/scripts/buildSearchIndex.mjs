// Build the global transcript search index served from R2 alongside the transcripts.
//
// Stage 1 downloads every published transcript (enumerated via episodes.json;
// the bucket has no listing endpoint, so a 404 means "no transcript yet") into
// a local cache. Stage 2 tokenizes the cached transcripts with the exact same
// normalizer the in-app search uses and writes a sharded inverted index:
//
//   <out>/v1/manifest.json      prefix -> shard map + episodeKey ordinal table
//   <out>/v1/shard-NNN.json     { tokens: { token: [ordinalDelta, count, ...] } }
//
// Usage:
//   node scripts/buildSearchIndex.mjs
//     [--cache-dir search-index-cache]  transcript download cache (reused across runs)
//     [--out search-index-dist]         output root; files land in <out>/v1/
//     [--concurrency 6]
//     [--skip-misses]                   don't re-check keys that 404'd on a previous run
//     [--limit N]                       smoke-test on the first N episodes
//
// Previously-missing keys are re-checked by default: coverage is still growing,
// and newly uploaded transcripts are exactly the keys that 404'd last time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSearchText } from "../public/js/player/transcriptSearch.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(SCRIPT_DIR);
const EPISODES_JSON = path.join(APP_DIR, "public", "data", "episodes.json");

const TRANSCRIPT_BASE_URL = "https://transcripts.pkcollection.net/mssp";
const SCHEMA_VERSION = 1;
const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_COUNT = 9999;
const SHARD_TARGET_BYTES = 64 * 1024;
const MAX_SHARD_FILES = 300;
const FETCH_RETRIES = 2;
const MISSES_FILE = "_misses.json";

function parseArgs(argv) {
  const args = {
    cacheDir: path.join(APP_DIR, "search-index-cache"),
    outDir: path.join(APP_DIR, "search-index-dist"),
    concurrency: 6,
    skipMisses: false,
    limit: Infinity,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cache-dir") args.cacheDir = path.resolve(argv[++i]);
    else if (arg === "--out") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 6);
    else if (arg === "--skip-misses") args.skipMisses = true;
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++i]) || Infinity);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readEpisodeKeys() {
  const payload = JSON.parse(fs.readFileSync(EPISODES_JSON, "utf8"));
  const keys = (payload.episodes || []).map((episode) => episode.episodeKey).filter(Boolean);
  if (!keys.length) throw new Error(`No episodeKeys found in ${EPISODES_JSON}`);
  return keys;
}

function transcriptUrl(episodeKey) {
  return `${TRANSCRIPT_BASE_URL}/${encodeURIComponent(episodeKey)}.json`;
}

function cachePath(cacheDir, episodeKey) {
  return path.join(cacheDir, `${episodeKey}.json`);
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 404) return { status: 404 };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { status: 200, body: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

async function downloadTranscripts({ episodeKeys, cacheDir, concurrency, skipMisses }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const missesPath = path.join(cacheDir, MISSES_FILE);
  const previousMisses = new Set(
    fs.existsSync(missesPath) ? JSON.parse(fs.readFileSync(missesPath, "utf8")) : [],
  );

  const available = [];
  const misses = new Set();
  const queue = [...episodeKeys];
  let downloaded = 0;
  let cached = 0;

  async function worker() {
    for (;;) {
      const key = queue.shift();
      if (key === undefined) return;
      if (fs.existsSync(cachePath(cacheDir, key))) {
        available.push(key);
        cached += 1;
        continue;
      }
      if (skipMisses && previousMisses.has(key)) {
        misses.add(key);
        continue;
      }
      const result = await fetchWithRetry(transcriptUrl(key));
      if (result.status === 404) {
        misses.add(key);
        continue;
      }
      fs.writeFileSync(cachePath(cacheDir, key), result.body);
      available.push(key);
      downloaded += 1;
      if (downloaded % 10 === 0) console.log(`  downloaded ${downloaded} transcripts...`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.writeFileSync(missesPath, JSON.stringify([...misses].sort(), null, 2));
  console.log(`Stage 1: ${available.length} transcripts (${cached} cached, ${downloaded} new), ${misses.size} without transcripts.`);
  return available;
}

export function tokenizeWordBody(body) {
  return normalizeSearchText(body)
    .split(" ")
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function countTokensForTranscript(payload, episodeKey) {
  if (payload?.format !== "mssp-transcript" || !Array.isArray(payload.segments)) {
    throw new Error(`Unexpected transcript format for "${episodeKey}"`);
  }
  const counts = new Map();
  for (const segment of payload.segments) {
    if (!Array.isArray(segment?.words)) continue;
    for (const word of segment.words) {
      for (const token of tokenizeWordBody(word?.body || "")) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
    }
  }
  return counts;
}

// postings: [[ordinal, count], ...] ascending -> flat delta-encoded pairs.
export function encodePostings(postings) {
  const flat = [];
  let previousOrdinal = 0;
  postings.forEach(([ordinal, count], index) => {
    flat.push(index === 0 ? ordinal : ordinal - previousOrdinal);
    flat.push(Math.min(count, MAX_TOKEN_COUNT));
    previousOrdinal = ordinal;
  });
  return flat;
}

export function decodePostings(flat) {
  const postings = [];
  let ordinal = 0;
  for (let i = 0; i < flat.length; i += 2) {
    ordinal += flat[i];
    postings.push([ordinal, flat[i + 1]]);
  }
  return postings;
}

// Group tokens by 2-char prefix, then greedy-pack prefixes (sorted) into shards
// of roughly SHARD_TARGET_BYTES. A prefix never splits across shards.
export function packShards(tokenPostings, targetBytes = SHARD_TARGET_BYTES) {
  const byPrefix = new Map();
  for (const [token, flat] of tokenPostings) {
    const prefix = token.slice(0, 2);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push([token, flat]);
  }

  const shards = [];
  const prefixToShard = {};
  let current = null;
  let currentBytes = 0;

  for (const prefix of [...byPrefix.keys()].sort()) {
    const entries = byPrefix.get(prefix);
    const prefixBytes = entries.reduce(
      (sum, [token, flat]) => sum + token.length + flat.length * 5 + 8,
      0,
    );
    if (!current || (currentBytes > 0 && currentBytes + prefixBytes > targetBytes)) {
      current = { name: `shard-${String(shards.length).padStart(3, "0")}.json`, tokens: {} };
      shards.push(current);
      currentBytes = 0;
    }
    for (const [token, flat] of entries) current.tokens[token] = flat;
    prefixToShard[prefix] = current.name;
    currentBytes += prefixBytes;
  }

  return { shards, prefixToShard };
}

function buildIndex({ episodeKeys, cacheDir, availableKeys }) {
  // Ordinals follow episodes.json order (globalIndex order) restricted to
  // episodes that have a transcript.
  const orderedAvailable = episodeKeys.filter((key) => availableKeys.includes(key));
  const tokenToPostings = new Map();
  let totalPostings = 0;

  orderedAvailable.forEach((episodeKey, ordinal) => {
    const payload = JSON.parse(fs.readFileSync(cachePath(cacheDir, episodeKey), "utf8"));
    const counts = countTokensForTranscript(payload, episodeKey);
    for (const [token, count] of counts) {
      if (!tokenToPostings.has(token)) tokenToPostings.set(token, []);
      tokenToPostings.get(token).push([ordinal, count]);
      totalPostings += 1;
    }
  });

  const tokenPostings = [...tokenToPostings.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([token, postings]) => [token, encodePostings(postings)]);

  return { orderedAvailable, tokenPostings, totalPostings };
}

function writeOutput({ outDir, episodeKeys, orderedAvailable, tokenPostings, totalPostings }) {
  const versionDir = path.join(outDir, "v1");
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(versionDir, { recursive: true });

  const { shards, prefixToShard } = packShards(tokenPostings);
  if (shards.length > MAX_SHARD_FILES) {
    throw new Error(`Shard count ${shards.length} exceeds ${MAX_SHARD_FILES}; raise SHARD_TARGET_BYTES.`);
  }

  const shardSizes = [];
  for (const shard of shards) {
    const body = JSON.stringify({ tokens: shard.tokens });
    fs.writeFileSync(path.join(versionDir, shard.name), body);
    shardSizes.push(Buffer.byteLength(body));
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    normalizer: "transcriptSearch-v1",
    minTokenLength: MIN_TOKEN_LENGTH,
    episodeKeys: orderedAvailable,
    shards: prefixToShard,
    stats: {
      episodesWithTranscripts: orderedAvailable.length,
      episodesTotal: episodeKeys.length,
      tokens: tokenPostings.length,
      postings: totalPostings,
      shardFiles: shards.length,
    },
  };
  const manifestBody = JSON.stringify(manifest);
  fs.writeFileSync(path.join(versionDir, "manifest.json"), manifestBody);

  shardSizes.sort((a, b) => a - b);
  const totalBytes = shardSizes.reduce((a, b) => a + b, 0) + Buffer.byteLength(manifestBody);
  console.log(`Stage 2: ${orderedAvailable.length}/${episodeKeys.length} episodes indexed.`);
  console.log(`  vocabulary: ${tokenPostings.length} tokens, ${totalPostings} postings`);
  console.log(`  shards: ${shards.length} files (min ${shardSizes[0] || 0} B, median ${shardSizes[Math.floor(shardSizes.length / 2)] || 0} B, max ${shardSizes[shardSizes.length - 1] || 0} B)`);
  console.log(`  manifest: ${Buffer.byteLength(manifestBody)} B, total output: ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`  output: ${versionDir}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const episodeKeys = readEpisodeKeys().slice(0, args.limit);
  console.log(`Indexing up to ${episodeKeys.length} episodes from ${TRANSCRIPT_BASE_URL}`);

  const availableKeys = await downloadTranscripts({
    episodeKeys,
    cacheDir: args.cacheDir,
    concurrency: args.concurrency,
    skipMisses: args.skipMisses,
  });
  if (!availableKeys.length) throw new Error("No transcripts available; nothing to index.");

  const index = buildIndex({ episodeKeys, cacheDir: args.cacheDir, availableKeys });
  writeOutput({ outDir: args.outDir, episodeKeys, ...index });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
