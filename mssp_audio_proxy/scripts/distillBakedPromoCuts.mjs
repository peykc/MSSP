// Distills batch-work/state.jsonl into the worker's data file
// (mssp_audio_proxy/data/baked-promo-cuts.json) plus a human-readable report.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const WORKER_DATA = "C:/Users/peyto/Desktop/Matt and Shane's Secret Podcast/MSSP/mssp_audio_proxy/data";
const lines = (await readFile(new URL("../.align-work/state.jsonl", import.meta.url), "utf8"))
  .split("\n").filter(Boolean).map(JSON.parse);

const byStatus = {};
for (const l of lines) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
console.log("statuses:", JSON.stringify(byStatus), "total:", lines.length);

const entries = {};
let totalSeconds = 0;
for (const l of lines) {
  if (l.status !== "cut") continue;
  if (entries[l.id]) throw new Error(`duplicate id ${l.id}`);
  if (l.localBytes !== l.postDaiBytes) {
    console.warn(`WARN ${l.episode}: localBytes ${l.localBytes} != HEAD postDaiBytes ${l.postDaiBytes}; using localBytes`);
  }
  entries[l.id] = {
    episodeKey: l.episodeKey,
    updated: l.updated ?? null,
    postDaiBytes: l.localBytes ?? l.postDaiBytes,
    cuts: l.cuts,
    secondsRemoved: l.secondsRemoved,
  };
  totalSeconds += l.secondsRemoved;
}

await mkdir(WORKER_DATA, { recursive: true });
await writeFile(`${WORKER_DATA}/baked-promo-cuts.json`, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: "Measured by offline alignment of proxy output vs promo-free archive rips. Post-DAI byte coordinates.",
  episodeCount: Object.keys(entries).length,
  totalSecondsRemoved: Number(totalSeconds.toFixed(1)),
  entries,
}, null, 2)}\n`);
console.log(`wrote ${Object.keys(entries).length} entries, ${totalSeconds.toFixed(0)}s of promos total`);

const remaining = lines.filter((l) => l.status === "flag" || l.status === "error");
const anomalies = lines.filter((l) => l.status.startsWith("anomaly"));
console.log("\nremaining flags/errors:");
for (const l of remaining) console.log(`  ${l.episode} ${l.date} ${l.reason}`);
console.log("\nanomalies (archive longer than public master):");
for (const l of anomalies) console.log(`  ${l.episode} ${l.date} delta=${l.exactDelta}s`);
