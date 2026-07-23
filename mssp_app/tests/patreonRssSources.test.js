const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

async function loadModule() {
  const source = await fs.promises.readFile(
    path.join(__dirname, "../public/js/sources/patreonRssSources.js"),
    "utf8",
  );
  // Stub browser-only imports so the detection helper can load under node:test.
  const rewritten = source
    .replace(
      /import\s+\{\s*matchPatreonSources,\s*normalizePatreonTitle\s*\}\s+from\s+"\.\/patreonRssMatcher\.js";/,
      "const matchPatreonSources = () => ({ matches: [], summary: {} }); const normalizePatreonTitle = (value) => value;",
    )
    .replace(
      /import\s+\{\s*addPatreonR2Sources,\s*hasPatreonR2Source\s*\}\s+from\s+"\.\/patreonR2Sources\.js";/,
      "const addPatreonR2Sources = () => 0; const hasPatreonR2Source = () => false;",
    );
  return import(`data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`);
}

test("treats tiny free feeds as public-only without hardcoding 13", async () => {
  const { isPublicOnlyPatreonFeed } = await loadModule();
  assert.equal(isPublicOnlyPatreonFeed({ feedItems: 13, eligibleEpisodes: 391 }), true);
  assert.equal(isPublicOnlyPatreonFeed({ feedItems: 40, eligibleEpisodes: 391 }), true);
  assert.equal(isPublicOnlyPatreonFeed({ feedItems: 484, eligibleEpisodes: 391 }), false);
  assert.equal(isPublicOnlyPatreonFeed({ feedItems: 391, eligibleEpisodes: 391 }), false);
});
