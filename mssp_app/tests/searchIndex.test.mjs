import assert from "node:assert/strict";
import test from "node:test";

import { encodePostings, decodePostings, packShards, tokenizeWordBody } from "../scripts/buildSearchIndex.mjs";
import { normalizeSearchText, buildSearchIndex } from "../public/js/player/transcriptSearch.js";

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
