const fs = require("node:fs");
const path = require("node:path");

const episodesPath = path.join(__dirname, "../public/data/episodes.json");
const raw = JSON.parse(fs.readFileSync(episodesPath, "utf8"));
const episodes = Array.isArray(raw) ? raw : raw.episodes || [];

const byDate = new Map();

for (const episode of episodes) {
  const date = (episode.publishedAt || episode.date || "").slice(0, 10);
  if (!date) continue;

  if (!byDate.has(date)) {
    byDate.set(date, { old: [], new: [], paytch: [], other: [] });
  }

  const bucket = byDate.get(date);
  const kind = episode.collectionKind;
  const title = episode.title || episode.name || episode.episodeKey || "(untitled)";

  if (kind === "old" || kind === "new" || kind === "paytch") {
    bucket[kind].push(title);
  } else {
    bucket.other.push({ kind, title });
  }
}

const kinds = ["old", "new", "paytch"];
const maxPerKind = { old: 0, new: 0, paytch: 0 };

for (const counts of byDate.values()) {
  for (const kind of kinds) {
    maxPerKind[kind] = Math.max(maxPerKind[kind], counts[kind].length);
  }
}

console.log(`Total episodes: ${episodes.length}`);
console.log(`Unique release dates: ${byDate.size}`);
console.log(`Max episodes from one kind on a single day:`, maxPerKind);

for (const kind of kinds) {
  const overTwo = [...byDate.entries()]
    .filter(([, counts]) => counts[kind].length > 2)
    .sort((a, b) => b[1][kind].length - a[1][kind].length);

  console.log(`\nDays with >2 ${kind}: ${overTwo.length}`);
  for (const [date, counts] of overTwo) {
    console.log(`  ${date} (${counts[kind].length}): ${counts[kind].join(" | ")}`);
  }

  const exactlyTwo = [...byDate.entries()]
    .filter(([, counts]) => counts[kind].length === 2)
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\nDays with exactly 2 ${kind}: ${exactlyTwo.length}`);
  for (const [date, counts] of exactlyTwo) {
    console.log(`  ${date}: ${counts[kind].join(" | ")}`);
  }
}

const testamentOverTwo = [...byDate.entries()]
  .filter(([, counts]) => counts.old.length + counts.new.length > 2)
  .sort(
    (a, b) =>
      b[1].old.length + b[1].new.length - (a[1].old.length + a[1].new.length),
  );

console.log(`\nDays with >2 testament episodes combined (old + new): ${testamentOverTwo.length}`);
for (const [date, counts] of testamentOverTwo) {
  console.log(
    `  ${date}: old=${counts.old.length}, new=${counts.new.length} — ${[...counts.old, ...counts.new].join(" | ")}`,
  );
}

const threePlusTotal = [...byDate.entries()]
  .filter(([, counts]) => counts.old.length + counts.new.length + counts.paytch.length > 2)
  .sort(
    (a, b) =>
      b[1].old.length +
      b[1].new.length +
      b[1].paytch.length -
      (a[1].old.length + a[1].new.length + a[1].paytch.length),
  );

console.log(`\nDays with >2 total releases (any mix): ${threePlusTotal.length}`);
for (const [date, counts] of threePlusTotal) {
  console.log(
    `  ${date}: old=${counts.old.length}, new=${counts.new.length}, paytch=${counts.paytch.length}`,
  );
}
