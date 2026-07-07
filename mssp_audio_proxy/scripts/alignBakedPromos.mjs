// Batch baked-promo aligner.
//
// Phase 1: HEAD every NT episode through the proxy (warms the edge cache and
//   returns the exact post-DAI byte length the worker will serve). Estimate the
//   duration delta vs the archive rip; anything within the estimator's noise is
//   provisionally clean.
// Phase 2: for candidates, download the proxied bytes, measure exactly with
//   ffprobe, find insertions by envelope alignment, refine boundaries, snap to
//   MP3 frames, apply the cuts locally, and verify duration + splice continuity
//   before emitting a cut-list entry. Anything that fails a check is flagged,
//   never guessed.
//
// The archive folder is READ ONLY (ffmpeg/ffprobe inputs only).
//
// Usage: node batch.mjs [--limit N] [--only ep1,ep2]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, appendFile, unlink, access, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const run = promisify(execFile);

const APP = "C:/Users/peyto/Desktop/Matt and Shane's Secret Podcast/MSSP/mssp_app";
const ARCHIVE_DIR = "C:/Users/peyto/Desktop/The Holy Trinity";
const WORK = new URL("../.align-work/", import.meta.url);
const STATE_FILE = new URL("state.jsonl", WORK);
const PROGRESS_FILE = new URL("progress.txt", WORK);

const HEAD_CONCURRENCY = 6;
const ALIGN_CONCURRENCY = 2;
const ESTIMATE_THRESHOLD_S = 2.5; // phase-1 estimator noise margin
const CLEAN_THRESHOLD_S = 1.2;    // exact ffprobe margin
const REAL_BITRATE = { 96000: 96078, 128000: 128104, 320000: 320114 };

const SR = 4000;
const HOP = 40; // 10 ms envelope
const SNIPPET_S = 5;

const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;

await mkdir(WORK, { recursive: true });

const episodes = JSON.parse(await readFile(`${APP}/public/data/episodes.json`, "utf8")).episodes;
const sources = JSON.parse(await readFile(`${APP}/public/data/sources.public.json`, "utf8")).sources;

let targets = episodes
  .filter((e) => e.collectionKind === "new" && sources[e.episodeKey]?.sourceType === "public_rss_audio" && sources[e.episodeKey].upstreamUrl)
  .map((e) => {
    const src = sources[e.episodeKey];
    const idMatch = /\/nt\/(GLT[A-Za-z0-9]+)\.mp3/.exec(src.url);
    const updated = /updated=(\d+)/.exec(src.url)?.[1] ?? null;
    return {
      episodeKey: e.episodeKey,
      episode: String(e.episode),
      date: e.date,
      archiveDuration: e.durationSeconds,
      archivePath: `${ARCHIVE_DIR}/${e.filename}`,
      proxiedUrl: src.url,
      id: idMatch?.[1],
      updated,
    };
  })
  .filter((t) => t.id);
if (only) targets = targets.filter((t) => only.has(t.episode));
targets = targets.slice(0, limit);

// Resume: skip episodes already recorded.
const done = new Set();
try {
  for (const line of (await readFile(STATE_FILE, "utf8")).split("\n")) {
    if (line.trim()) done.add(JSON.parse(line).episodeKey);
  }
} catch {}
targets = targets.filter((t) => !done.has(t.episodeKey));

async function record(entry) {
  await appendFile(STATE_FILE, `${JSON.stringify(entry)}\n`);
}
async function progress(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  await appendFile(PROGRESS_FILE, `${line}\n`);
}

await progress(`starting: ${targets.length} episodes to process`);

// ---------- shared audio helpers ----------

async function ffprobeDuration(input) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input]);
  return Number(stdout.trim());
}

async function envelope(input, startS, lengthS) {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(Math.max(0, startS)), "-t", String(lengthS), "-i", input,
    "-ac", "1", "-ar", String(SR), "-f", "s16le", "-",
  ], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const env = new Float64Array(Math.floor(samples.length / HOP));
  for (let i = 0; i < env.length; i += 1) {
    let sum = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j += 1) sum += samples[j] * samples[j];
    env[i] = Math.sqrt(sum / HOP);
  }
  return env;
}

function bestLag(needle, haystack) {
  let best = { corr: -1, lag: 0 };
  for (let lag = 0; lag + needle.length <= haystack.length; lag += 1) {
    let dot = 0;
    let nn = 0;
    let hh = 0;
    for (let i = 0; i < needle.length; i += 1) {
      const h = haystack[lag + i];
      dot += needle[i] * h;
      nn += needle[i] * needle[i];
      hh += h * h;
    }
    const corr = nn && hh ? dot / Math.sqrt(nn * hh) : 0;
    if (corr > best.corr) best = { corr, lag };
  }
  // Parabolic sub-hop refinement around the peak.
  const at = (lag) => {
    if (lag < 0 || lag + needle.length > haystack.length) return -1;
    let dot = 0;
    let nn = 0;
    let hh = 0;
    for (let i = 0; i < needle.length; i += 1) {
      const h = haystack[lag + i];
      dot += needle[i] * h;
      nn += needle[i] * needle[i];
      hh += h * h;
    }
    return nn && hh ? dot / Math.sqrt(nn * hh) : -1;
  };
  const y0 = at(best.lag - 1);
  const y1 = best.corr;
  const y2 = at(best.lag + 1);
  let frac = 0;
  const denom = y0 - 2 * y1 + y2;
  if (y0 >= 0 && y2 >= 0 && Math.abs(denom) > 1e-9) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
  return { corr: best.corr, lagSeconds: ((best.lag + frac) * HOP) / SR };
}

// Offset of proxied relative to archive at archive-time t.
async function offsetAt(archivePath, proxiedPath, t, maxOffset) {
  const needle = await envelope(archivePath, t, SNIPPET_S);
  const windowStart = Math.max(0, t - 2);
  const haystack = await envelope(proxiedPath, windowStart, SNIPPET_S + maxOffset + 4);
  const { corr, lagSeconds } = bestLag(needle, haystack);
  return { offset: windowStart + lagSeconds - t, corr };
}

// ---------- phase 1: proxy HEAD + estimate ----------

async function phase1(t) {
  const res = await fetch(t.proxiedUrl, { method: "HEAD" });
  if (res.status !== 200) throw new Error(`proxy HEAD ${res.status}`);
  const postDaiBytes = Number(res.headers.get("content-length"));
  if (!Number.isInteger(postDaiBytes) || postDaiBytes <= 0) throw new Error("no content-length from proxy");
  return { postDaiBytes, promosRemoved: res.headers.get("x-mssp-promos-removed") || "" };
}

// ---------- phase 2: download + align + cut + verify ----------

async function download(url, dest) {
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`proxy GET ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// ID3v2 tags (embedded artwork can be ~100 KB) sit before the first MP3 frame;
// time->byte mapping must exclude them or cuts land seconds off target.
function id3TagEnd(bytes) {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = (bytes[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

function frameLength(bytes, off) {
  if (bytes[off] !== 0xff || (bytes[off + 1] & 0xe0) !== 0xe0) return null;
  const b2 = bytes[off + 2];
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const samples = [44100, 48000, 32000, 0];
  const bitrate = bitrates[(b2 >> 4) & 0x0f] * 1000;
  const sampleRate = samples[(b2 >> 2) & 0x03];
  if (!bitrate || !sampleRate) return null;
  return Math.floor((144 * bitrate) / sampleRate) + ((b2 >> 1) & 0x01);
}

function snapToFrame(bytes, byteOffset, searchLimit = 3000) {
  for (let candidate = Math.max(0, Math.round(byteOffset)); candidate < byteOffset + searchLimit && candidate < bytes.length; candidate += 1) {
    let off = candidate;
    let ok = true;
    for (let i = 0; i < 4; i += 1) {
      const len = frameLength(bytes, off);
      if (len === null) { ok = false; break; }
      off += len;
    }
    if (ok) return candidate;
  }
  throw new Error(`no MP3 frame boundary near byte ${Math.round(byteOffset)}`);
}

async function findSteps(t, proxiedPath, exactDelta) {
  const maxOffset = exactDelta + 15;
  const anchors = [];
  const GRID = 8;
  for (let i = 0; i <= GRID; i += 1) {
    // Grid starts near 0 so a pre-roll insertion shows up as a step before the
    // first anchor rather than a uniform offset the step-scan would miss.
    const at = Math.min(t.archiveDuration - SNIPPET_S - 2, 0.5 + (i * (t.archiveDuration - 9)) / GRID);
    const probe = await offsetAt(t.archivePath, proxiedPath, at, maxOffset);
    anchors.push({ t: at, ...probe });
  }
  const weak = anchors.filter((a) => a.corr < 0.85);
  if (weak.length > 2) throw new Error(`weak anchors (${weak.length}); content mismatch?`);

  const steps = [];
  // A nonzero offset already at the first anchor means a head insertion
  // (pre-roll promo) before archive t=0.5 â€” no between-anchor step exists.
  if (anchors[0].offset > 0.5) {
    steps.push({ head: true, boundaryT: 0, offsetBefore: 0, offsetAfter: anchors[0].offset });
  }
  // Worklist of gaps whose endpoint offsets differ; a gap can contain several
  // insertions, so after finding one boundary the remainder is re-queued.
  const gaps = [];
  for (let i = 0; i + 1 < anchors.length; i += 1) gaps.push([anchors[i], anchors[i + 1]]);
  while (gaps.length) {
    const [gapLo, gapHi] = gaps.pop();
    if (Math.abs(gapHi.offset - gapLo.offset) < 0.5) continue;
    let lo = gapLo;
    let hi = gapHi;
    while (hi.t - lo.t > 0.6) {
      const mid = (lo.t + hi.t) / 2;
      const probe = { t: mid, ...(await offsetAt(t.archivePath, proxiedPath, mid, maxOffset)) };
      if (Math.abs(probe.offset - lo.offset) < 0.5) lo = probe;
      else hi = probe;
    }
    steps.push({ boundaryT: (lo.t + hi.t) / 2, offsetBefore: lo.offset, offsetAfter: hi.offset });
    if (Math.abs(gapHi.offset - hi.offset) >= 0.5) gaps.push([hi, gapHi]);
  }
  steps.sort((a, b) => (a.boundaryT ?? 0) - (b.boundaryT ?? 0));

  // Delta not accounted for by head/mid steps, with the last anchor's offset
  // matching what IS accounted: the remainder is appended after the archive's
  // final content (post-roll promo). The duration check catches false positives.
  const accountedInSteps = steps.reduce((sum, s) => sum + (s.offsetAfter - s.offsetBefore), 0);
  const tailRemainder = exactDelta - accountedInSteps;
  const lastOffset = anchors[anchors.length - 1].offset;
  if (tailRemainder > 1 && Math.abs(lastOffset - accountedInSteps) < 0.5) {
    steps.push({ tail: true, offsetBefore: lastOffset, offsetAfter: lastOffset + tailRemainder });
  }

  return { anchors, steps };
}

// Measures the archive->proxied offset near expectedOffset using the first of
// several candidate probe positions that correlates well â€” outro/break music
// makes single fixed positions unreliable.
async function measureOffsetNear(t, proxiedPath, candidates, expectedOffset) {
  let best = null;
  for (const tc of candidates) {
    if (tc < 0.2 || tc + SNIPPET_S > t.archiveDuration - 0.5) continue;
    const needle = await envelope(t.archivePath, tc, SNIPPET_S);
    const hayStart = Math.max(0, tc + expectedOffset - 2);
    const hay = await envelope(proxiedPath, hayStart, SNIPPET_S + 4);
    const r = bestLag(needle, hay);
    const offset = hayStart + r.lagSeconds - tc;
    if (!best || r.corr > best.corr) best = { corr: r.corr, offset, at: tc };
    if (r.corr >= 0.93) break;
  }
  if (!best || best.corr < 0.8) {
    throw new Error(`offset probe corr ${best ? best.corr.toFixed(3) : "n/a"}`);
  }
  return best;
}

async function refineStep(t, proxiedPath, step) {
  if (step.head) {
    // Head insertion: everything (past any ID3 tag) before the point where
    // archive content begins is promo. The resume offset can be measured at any
    // post-insertion position, so several candidates dodge intro music.
    const post = await measureOffsetNear(
      t, proxiedPath,
      [0.3, 5, 15, 30].map((s) => s + 0),
      step.offsetAfter,
    );
    return { startS: 0, lengthS: post.offset, preCorr: 1, postCorr: post.corr, head: true };
  }

  if (step.tail) {
    // Confirm the offset near the archive's end (probing earlier speech if the
    // outro music is ambiguous), then cut from where the archive's final
    // content ends (archiveDuration + offset) to EOF.
    const dur = t.archiveDuration;
    const pre = await measureOffsetNear(
      t, proxiedPath,
      [dur - 1 - SNIPPET_S, dur - 12 - SNIPPET_S, dur - 25 - SNIPPET_S, dur - 45 - SNIPPET_S],
      step.offsetBefore,
    );
    return {
      startS: dur + pre.offset,
      lengthS: step.offsetAfter - step.offsetBefore,
      preCorr: pre.corr,
      postCorr: 1,
      tail: true,
    };
  }

  // Insertion start in proxied: end of the last pre-boundary archive audio.
  // Needle length adapts when the boundary sits near the start of the episode.
  const needleLen = Math.min(SNIPPET_S, step.boundaryT - 0.8);
  if (needleLen < 1.2) {
    // Boundary within ~2s of the start: no room for a pre-needle. Cut from the
    // first frame to the content resume point; the duration check rejects the
    // cut if that sacrifices more than a sliver of intro.
    const post = await measureOffsetNear(
      t, proxiedPath,
      [step.boundaryT + 1, step.boundaryT + 6, step.boundaryT + 12],
      step.offsetAfter,
    );
    return { startS: 0, lengthS: step.boundaryT + post.offset, preCorr: 1, postCorr: post.corr, head: true };
  }
  const preT = step.boundaryT - 0.4 - needleLen;
  const preNeedle = await envelope(t.archivePath, preT, needleLen);
  const preHayStart = Math.max(0, preT + step.offsetBefore - 2);
  const preHay = await envelope(proxiedPath, preHayStart, needleLen + 4);
  const pre = bestLag(preNeedle, preHay);
  if (pre.corr < 0.85) throw new Error(`pre-boundary corr ${pre.corr.toFixed(3)}`);
  const insertStart = preHayStart + pre.lagSeconds + needleLen;

  // The resume offset can be measured at any post-insertion position; try a few
  // to dodge break music.
  const post = await measureOffsetNear(
    t, proxiedPath,
    [step.boundaryT + 1, step.boundaryT + 6, step.boundaryT + 12, step.boundaryT + 20],
    step.offsetAfter,
  );

  // insertStart is absolute in proxied time; the insertion ends where the
  // post-boundary offset resumes: end = start + (offsetAfter - offsetBefore).
  return {
    startS: insertStart,
    lengthS: post.offset - step.offsetBefore,
    preCorr: pre.corr,
    postCorr: post.corr,
  };
}

async function verifyCuts(t, proxiedPath, bytes, cuts) {
  const cutParts = [];
  let cursor = 0;
  for (const [s, e] of cuts) {
    cutParts.push(bytes.subarray(cursor, s));
    cursor = e;
  }
  cutParts.push(bytes.subarray(cursor));
  const cutFile = new URL(`cutcheck-${t.episode}.mp3`, WORK);
  await writeFile(cutFile, Buffer.concat(cutParts));

  try {
    const cutDur = await ffprobeDuration(cutFile.pathname.slice(1));
    const durDelta = cutDur - t.archiveDuration;
    if (Math.abs(durDelta) > 0.8) return { ok: false, reason: `cut duration delta ${durDelta.toFixed(2)}s` };

    // Global timeline verification: the whole cut file must align to the
    // archive at a CONSTANT lag (editions can differ by a small fixed baseline,
    // e.g. 0.15s of leader; what must not exist is a lag STEP, which would mean
    // promo audio survived or content was cut). Checkpoints landing on
    // ambiguous break music (low corr) are ignored.
    const checkpoints = [];
    const N = 8;
    for (let i = 0; i <= N; i += 1) {
      const at = Math.min(cutDur - SNIPPET_S - 2, 2 + (i * (cutDur - 10)) / N);
      const hayStart = Math.max(0, at - 3);
      const needle = await envelope(cutFile.pathname.slice(1), at, SNIPPET_S);
      const hay = await envelope(t.archivePath, hayStart, SNIPPET_S + 6);
      const { corr, lagSeconds } = bestLag(needle, hay);
      checkpoints.push({ t: Number(at.toFixed(1)), corr: Number(corr.toFixed(3)), lag: Number((hayStart + lagSeconds - at).toFixed(3)) });
    }
    const usable = checkpoints.filter((c) => c.corr >= 0.75);
    if (usable.length < 5) return { ok: false, reason: `only ${usable.length}/9 usable checkpoints`, checkpoints };
    const lags = usable.map((c) => c.lag).sort((a, b) => a - b);
    const median = lags[Math.floor(lags.length / 2)];
    const spread = lags[lags.length - 1] - lags[0];
    if (Math.abs(median) > 0.6) return { ok: false, reason: `baseline offset ${median.toFixed(3)}s vs archive`, checkpoints };
    if (spread > 0.15) return { ok: false, reason: `timeline spread ${spread.toFixed(3)}s`, checkpoints };

    return { ok: true, cutDuration: Number(cutDur.toFixed(3)), baseline: median, spread: Number(spread.toFixed(3)), checkpoints };
  } finally {
    await unlink(cutFile).catch(() => {});
  }
}

async function phase2(t, head) {
  const tmp = new URL(`dl-${t.episode}.mp3`, WORK).pathname.slice(1);
  try {
    await download(t.proxiedUrl, tmp);
    const exactDur = await ffprobeDuration(tmp);
    const exactDelta = exactDur - t.archiveDuration;

    if (Math.abs(exactDelta) <= CLEAN_THRESHOLD_S) {
      return { status: "clean", exactDelta: Number(exactDelta.toFixed(3)), postDaiBytes: head.postDaiBytes };
    }
    if (exactDelta < 0) {
      return { status: "anomaly-archive-longer", exactDelta: Number(exactDelta.toFixed(3)), postDaiBytes: head.postDaiBytes };
    }

    const { steps } = await findSteps(t, tmp, exactDelta);
    if (!steps.length) return { status: "flag", reason: `delta ${exactDelta.toFixed(1)}s but no offset step found` };
    const accounted = steps.reduce((sum, s) => sum + (s.offsetAfter - s.offsetBefore), 0);
    if (Math.abs(accounted - exactDelta) > 1.5) {
      return { status: "flag", reason: `steps account ${accounted.toFixed(1)}s of ${exactDelta.toFixed(1)}s` };
    }

    const bytes = await readFile(tmp);
    const audioStart = id3TagEnd(bytes);
    const bytesPerSecond = (bytes.length - audioStart) / exactDur;
    const byteFor = (seconds) => audioStart + seconds * bytesPerSecond;
    const cuts = [];
    const meta = [];
    for (const step of steps) {
      const refined = await refineStep(t, tmp, step);
      // Head cut starts at the first MP3 frame past the ID3 tag.
      const startByte = refined.head
        ? snapToFrame(bytes, audioStart, 4096)
        : snapToFrame(bytes, byteFor(refined.startS));
      const endByte = refined.tail
        ? bytes.length
        : snapToFrame(bytes, byteFor(refined.startS + refined.lengthS));
      cuts.push([startByte, endByte]);
      meta.push({ ...refined, startS: Number(refined.startS.toFixed(3)), lengthS: Number(refined.lengthS.toFixed(3)) });
    }
    cuts.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < cuts.length; i += 1) {
      if (cuts[i][1] <= cuts[i][0]) return { status: "flag", reason: `inverted cut at ${cuts[i][0]}` };
      if (i > 0 && cuts[i][0] < cuts[i - 1][1]) return { status: "flag", reason: "overlapping cuts" };
    }

    let verdict = await verifyCuts(t, tmp, bytes, cuts);
    // One correction pass: a lag step across a cut means its end missed by that
    // much; shift the end and re-verify.
    if (!verdict.ok && verdict.checkpoints && /timeline spread/.test(verdict.reason)) {
      let removedBefore = 0;
      const median = (arr) => arr.map((c) => c.lag).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      for (let i = 0; i < cuts.length; i += 1) {
        const spliceT = (cuts[i][0] - audioStart - removedBefore) / bytesPerSecond;
        removedBefore += cuts[i][1] - cuts[i][0];
        const before = verdict.checkpoints.filter((c) => c.corr >= 0.75 && c.t < spliceT - 6);
        const after = verdict.checkpoints.filter((c) => c.corr >= 0.75 && c.t > spliceT + 6);
        if (!before.length || !after.length) continue;
        const residual = median(after) - median(before);
        if (Math.abs(residual) > 0.03 && Math.abs(residual) < 0.6) {
          cuts[i][1] = snapToFrame(bytes, cuts[i][1] + residual * bytesPerSecond);
        }
      }
      verdict = await verifyCuts(t, tmp, bytes, cuts);
    }
    if (!verdict.ok) return { status: "flag", reason: verdict.reason, cuts, meta, checkpoints: verdict.checkpoints };

    return {
      status: "cut",
      postDaiBytes: head.postDaiBytes,
      localBytes: bytes.length,
      exactDelta: Number(exactDelta.toFixed(3)),
      cuts,
      secondsRemoved: Number((cuts.reduce((sum, [s, e]) => sum + (e - s), 0) / bytesPerSecond).toFixed(3)),
      meta,
      verify: verdict,
    };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---------- main loop ----------

let headIndex = 0;
const headResults = new Map();
await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, async () => {
  while (headIndex < targets.length) {
    const t = targets[headIndex++];
    try {
      await access(t.archivePath);
      headResults.set(t.episodeKey, await phase1(t));
    } catch (error) {
      headResults.set(t.episodeKey, { error: String(error.message || error) });
    }
    if (headResults.size % 25 === 0) await progress(`phase1 ${headResults.size}/${targets.length}`);
  }
}));
await progress(`phase1 done (${headResults.size})`);

let alignIndex = 0;
let counts = { clean: 0, cut: 0, flag: 0, anomaly: 0, error: 0 };
await Promise.all(Array.from({ length: ALIGN_CONCURRENCY }, async () => {
  while (alignIndex < targets.length) {
    const t = targets[alignIndex++];
    const head = headResults.get(t.episodeKey);
    try {
      if (head.error) throw new Error(head.error);
      // Estimate duration from postDai bytes: pick the CBR family whose implied
      // delta is smallest (families are 2.5x apart, so no ambiguity).
      let estDelta = null;
      for (const [declared, actual] of Object.entries(REAL_BITRATE)) {
        const est = (head.postDaiBytes * 8) / actual - t.archiveDuration;
        if (estDelta === null || Math.abs(est) < Math.abs(estDelta)) estDelta = est;
      }
      let result;
      if (Math.abs(estDelta) <= ESTIMATE_THRESHOLD_S) {
        result = { status: "clean-estimated", estDelta: Number(estDelta.toFixed(2)), postDaiBytes: head.postDaiBytes };
      } else {
        result = await phase2(t, head);
      }
      const key = result.status.startsWith("clean") ? "clean" : result.status === "cut" ? "cut" : result.status.startsWith("anomaly") ? "anomaly" : "flag";
      counts[key] += 1;
      await record({ episodeKey: t.episodeKey, episode: t.episode, date: t.date, id: t.id, updated: t.updated, ...result });
      await progress(`${t.episode} ${result.status}${result.reason ? ` (${result.reason})` : ""}${result.secondsRemoved ? ` -${result.secondsRemoved}s` : ""} [${alignIndex}/${targets.length}]`);
    } catch (error) {
      counts.error += 1;
      await record({ episodeKey: t.episodeKey, episode: t.episode, date: t.date, id: t.id, updated: t.updated, status: "error", reason: String(error.message || error) });
      await progress(`${t.episode} ERROR ${error.message || error} [${alignIndex}/${targets.length}]`);
    }
  }
}));

await progress(`done: ${JSON.stringify(counts)}`);
