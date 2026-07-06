import assert from "node:assert/strict";
import test from "node:test";

test("community identity persists one UUID and reuses it", async () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  let calls = 0;
  const cryptoApi = {
    randomUUID() {
      calls += 1;
      return "7f52ca32-8f4c-4f6b-917e-13b9933a61aa";
    },
  };
  const module = await import(`../public/js/community/communityIdentity.js?persist=${Date.now()}`);
  assert.equal(module.getCommunityClientId({ storage, cryptoApi }), "7f52ca32-8f4c-4f6b-917e-13b9933a61aa");
  assert.equal(module.getCommunityClientId({ storage, cryptoApi }), "7f52ca32-8f4c-4f6b-917e-13b9933a61aa");
  assert.equal(calls, 1);
});

test("community identity falls back to session memory when storage throws", async () => {
  const storage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  let calls = 0;
  const cryptoApi = {
    randomUUID() {
      calls += 1;
      return "bddab51d-b7fa-4bb5-b7df-fc090d38d15f";
    },
  };
  const module = await import(`../public/js/community/communityIdentity.js?memory=${Date.now()}`);
  assert.equal(module.getCommunityClientId({ storage, cryptoApi }), "bddab51d-b7fa-4bb5-b7df-fc090d38d15f");
  assert.equal(module.getCommunityClientId({ storage, cryptoApi }), "bddab51d-b7fa-4bb5-b7df-fc090d38d15f");
  assert.equal(calls, 1);
});
