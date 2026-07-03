const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let matcherPromise;
function loadMatcher() {
  matcherPromise ||= fs.promises
    .readFile(path.join(__dirname, "../public/js/sources/patreonRssMatcher.js"), "utf8")
    .then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
  return matcherPromise;
}

function episode(overrides = {}) {
  return {
    episodeKey: "2024-01-10 MSSP PAYTCH Ep. 500 - The Great Cast",
    date: "2024-01-10",
    episode: "500",
    title: "The Great Cast",
    paytch: "PAYTCH",
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    guid: "guid-1",
    pubDate: "2024-01-10",
    title: "MSSP Patreon Ep. 500 - The Great Cast",
    enclosureUrl: "https://cdn.example.test/audio.mp3",
    ...overrides,
  };
}

test("matches normalized title and exact date", async () => {
  const { matchPatreonSources } = await loadMatcher();
  const result = matchPatreonSources({ episodes: [episode()], candidates: [candidate()] });
  assert.equal(result.summary.matched, 1);
  assert.equal(result.matches[0].kind, "automatic");
});

test("does not match a date-only candidate", async () => {
  const { matchPatreonSources } = await loadMatcher();
  const result = matchPatreonSources({
    episodes: [episode()],
    candidates: [candidate({ title: "Completely Different Bonus" })],
  });
  assert.equal(result.summary.matched, 0);
});

test("leaves ambiguous duplicate-date candidates unmatched", async () => {
  const { matchPatreonSources } = await loadMatcher();
  const episodes = [
    episode({ episodeKey: "one", episode: "EX", title: "Psych Naw Ep 5" }),
    episode({ episodeKey: "two", episode: "EX", title: "Psych Naw Ep 6" }),
  ];
  const candidates = [
    candidate({ guid: "five", title: "Psych Naw", pubDate: "2024-01-10" }),
    candidate({ guid: "six", title: "Psych Naw", pubDate: "2024-01-10" }),
  ];
  const result = matchPatreonSources({ episodes, candidates });
  assert.equal(result.summary.matched, 0);
});

test("manual overrides win without double assigning a feed item", async () => {
  const { matchPatreonSources } = await loadMatcher();
  const episodes = [episode(), episode({ episodeKey: "second", title: "Another Cast" })];
  const candidates = [candidate()];
  const result = matchPatreonSources({
    episodes,
    candidates,
    overrides: { second: { guid: "guid-1" } },
  });
  assert.equal(result.summary.matched, 1);
  assert.equal(result.matches[0].episode.episodeKey, "second");
  assert.equal(result.matches[0].kind, "manual");
});

test("ignores non-PAYTCH episodes", async () => {
  const { matchPatreonSources } = await loadMatcher();
  const result = matchPatreonSources({
    episodes: [episode({ paytch: "" })],
    candidates: [candidate()],
  });
  assert.equal(result.summary.eligibleEpisodes, 0);
  assert.equal(result.summary.matched, 0);
});

test("manual override keys reference catalog PAYTCH episodes", () => {
  const episodesPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/data/episodes.json"), "utf8"));
  const overridesPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/data/patreon-rss-overrides.json"), "utf8"));
  const paytchKeys = new Set(
    episodesPayload.episodes
      .filter((entry) => entry.paytch === "PAYTCH")
      .map((entry) => entry.episodeKey),
  );

  const staleKeys = Object.keys(overridesPayload.matches).filter((episodeKey) => !paytchKeys.has(episodeKey));
  assert.deepEqual(staleKeys, []);
});
