import assert from "node:assert/strict";
import test from "node:test";

import { encodePostings, decodePostings, packShards, tokenizeWordBody } from "../scripts/buildSearchIndex.mjs";
import {
  normalizeSearchText,
  buildSearchIndex,
  parseSearchQuery,
  episodeMatchesSearchQuery,
} from "../public/js/player/transcriptSearch.js";

test("postings delta encoding round-trips", () => {
  const postings = [[3, 12], [5, 1], [41, 2], [900, 9999]];
  const flat = encodePostings(postings);
  assert.deepEqual(flat, [3, 12, 2, 1, 36, 2, 859, 9999]);
  assert.deepEqual(decodePostings(flat), postings);
});

test("postings counts are capped", () => {
  const flat = encodePostings([[0, 50000]]);
  assert.deepEqual(decodePostings(flat), [[0, 9999]]);
});

test("tokenizer matches the client normalizer", () => {
  assert.deepEqual(tokenizeWordBody("Don't"), ["dont"]);
  assert.deepEqual(tokenizeWordBody("BUSINESS!"), ["business"]);
  assert.deepEqual(tokenizeWordBody("half-baked"), ["half", "baked"]);
  assert.deepEqual(tokenizeWordBody("a"), []);
  assert.deepEqual(tokenizeWordBody("  "), []);
});

test("indexed tokens are findable by the client search", () => {
  const words = ["Don't", "tread", "on", "ME,", "pal!"];
  const timeline = [{
    type: "segment",
    startTime: 0,
    endTime: 5,
    words: words.map((body, i) => ({ body, startTime: i, endTime: i + 1 })),
  }];
  for (const body of words) {
    for (const token of tokenizeWordBody(body)) {
      const matches = buildSearchIndex(timeline, token);
      assert.ok(matches.length > 0, `client search should find indexed token "${token}"`);
    }
  }
});

test("packShards never splits a prefix and is deterministic", () => {
  const tokenPostings = [];
  for (const prefix of ["aa", "ab", "ba", "bb", "ca"]) {
    for (let i = 0; i < 40; i += 1) {
      tokenPostings.push([`${prefix}token${i}`, encodePostings([[i, 1], [i + 10, 2]])]);
    }
  }
  const first = packShards(tokenPostings, 1024);
  const second = packShards(tokenPostings, 1024);
  assert.deepEqual(first, second);

  // Every token of a given prefix must map to that prefix's single shard.
  for (const [token] of tokenPostings) {
    const prefix = token.slice(0, 2);
    const shardName = first.prefixToShard[prefix];
    const shard = first.shards.find((s) => s.name === shardName);
    assert.ok(shard, `prefix ${prefix} maps to a shard`);
    assert.ok(token in shard.tokens, `token ${token} lives in its prefix shard`);
  }
  assert.ok(first.shards.length > 1, "small target size produces multiple shards");
});

test("normalizeSearchText strips apostrophes and punctuation consistently", () => {
  assert.equal(normalizeSearchText("Matt's “special” DAY!"), "matts special day");
});

function makeTimeline(words) {
  return [{
    type: "segment",
    startTime: 0,
    endTime: words.length,
    words: words.map((body, i) => ({ body, startTime: i, endTime: i + 1 })),
  }];
}

test("quoted term requires an exact whole-word match", () => {
  const timeline = makeTimeline(["catch", "this", "cat"]);
  assert.equal(buildSearchIndex(timeline, "cat").length, 2);
  assert.equal(buildSearchIndex(timeline, '"cat"').length, 1);
  assert.equal(buildSearchIndex(timeline, '"cat"')[0].wordIndex, 2);
});

test("quoted phrase requires consecutive exact words", () => {
  const timeline = makeTimeline(["secret", "podcast", "night"]);
  assert.ok(buildSearchIndex(timeline, '"secret podcast"').length);
  assert.equal(buildSearchIndex(timeline, '"secret night"').length, 0);
  assert.equal(buildSearchIndex(timeline, '"podcast secret"').length, 0);
});

test("minus excludes matching segments", () => {
  const timeline = makeTimeline(["secret", "podcast", "patreon"]);
  assert.ok(buildSearchIndex(timeline, "secret").length);
  assert.equal(buildSearchIndex(timeline, "secret -patreon").length, 0);
  assert.equal(buildSearchIndex(timeline, 'secret -"patreon"').length, 0);
});

test("OR matches either branch", () => {
  const timeline = makeTimeline(["matt", "and", "shane"]);
  assert.ok(buildSearchIndex(timeline, "matt OR peyton").length);
  assert.ok(buildSearchIndex(timeline, "peyton OR shane").length);
  assert.equal(buildSearchIndex(timeline, "peyton OR luke").length, 0);
});

test("parseSearchQuery understands operators", () => {
  const parsed = parseSearchQuery('matt "secret podcast" -patreon OR paytch');
  assert.equal(parsed.includeBranches.length, 2);
  assert.deepEqual(parsed.includeBranches[0].map((c) => ({ text: c.text, exact: c.exact })), [
    { text: "matt", exact: false },
    { text: "secret podcast", exact: true },
  ]);
  assert.deepEqual(parsed.includeBranches[1].map((c) => c.text), ["paytch"]);
  assert.deepEqual(parsed.exclude.map((c) => c.text), ["patreon"]);
});

test("episodeMatchesSearchQuery applies exact and exclude filters", () => {
  const episode = {
    title: "The Catchphrase Special",
    episodeKey: "catchphrase",
    date: "2020-01-01",
  };
  assert.equal(episodeMatchesSearchQuery(episode, "catch"), true);
  assert.equal(episodeMatchesSearchQuery(episode, '"catch"'), false);
  assert.equal(episodeMatchesSearchQuery(episode, '"special"'), true);
  assert.equal(episodeMatchesSearchQuery(episode, "special -catch"), false);
});