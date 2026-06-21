const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

async function loadModule(relativePath) {
  const source = await fs.promises.readFile(path.join(__dirname, relativePath), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const UFC_EPISODE = {
  episodeKey: "2025-11-13 MSSP PAYTCH Ep. 585 - UFC GAMING TOURNAMENT",
  paytch: "PAYTCH",
};

test("adds the gated UFC R2 source after Patreon validation", async () => {
  const { addPatreonR2Sources } = await loadModule("../public/js/sources/patreonR2Sources.js");
  const sources = {};

  assert.equal(addPatreonR2Sources([UFC_EPISODE], sources), 1);
  assert.equal(sources[UFC_EPISODE.episodeKey].sourceType, "patreon_r2_audio");
  assert.match(sources[UFC_EPISODE.episodeKey].url, /\/paytch\/.*UFC%20GAMING%20TOURNAMENT\.mp3$/);
});

test("does not expose the fallback for unrelated or non-PAYTCH entries", async () => {
  const { addPatreonR2Sources } = await loadModule("../public/js/sources/patreonR2Sources.js");
  const sources = {};

  assert.equal(addPatreonR2Sources([{ ...UFC_EPISODE, paytch: "" }], sources), 0);
  assert.deepEqual(sources, {});
});

test("recognizes gated R2 audio as ready only when a source is present", async () => {
  const { getSourceStatus, SOURCE_STATUSES } = await loadModule("../public/js/player/sourceStatus.js");

  assert.equal(getSourceStatus(UFC_EPISODE).id, SOURCE_STATUSES.RSS_REQUIRED);
  assert.equal(getSourceStatus(UFC_EPISODE, {
    sourceType: "patreon_r2_audio",
    url: "https://mssp.pkcollection.net/paytch/example.mp3",
  }).id, SOURCE_STATUSES.READY);
});
