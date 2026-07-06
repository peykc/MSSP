const assert = require("node:assert/strict");
const test = require("node:test");
const { buildProxiedNtUrl } = require("../scripts/lib/rssMatcher");
const { NT_AUDIO_PROXY_BASE } = require("../scripts/rssFeeds.config");

test("rewrites Megaphone enclosures onto the audio proxy", () => {
  assert.equal(
    buildProxiedNtUrl("https://traffic.megaphone.fm/GLT7394383255.mp3?updated=1738626247"),
    `${NT_AUDIO_PROXY_BASE}/nt/GLT7394383255.mp3?updated=1738626247`,
  );
  assert.equal(
    buildProxiedNtUrl("https://traffic.megaphone.fm/GLT123abc.mp3"),
    `${NT_AUDIO_PROXY_BASE}/nt/GLT123abc.mp3`,
  );
});

test("returns null for anything that is not a plain Megaphone enclosure", () => {
  for (const url of [
    "https://evil.example/GLT123.mp3?updated=1",
    "https://traffic.megaphone.fm/notglt.mp3",
    "https://traffic.megaphone.fm/GLT123.wav",
    "https://traffic.megaphone.fm/GLT123.mp3?updated=abc",
    "https://traffic.megaphone.fm/GLT123.mp3?updated=1&extra=1",
    "http://traffic.megaphone.fm/GLT123.mp3",
    "not a url",
    "",
  ]) {
    assert.equal(buildProxiedNtUrl(url), null, `expected null for ${url}`);
  }
});
