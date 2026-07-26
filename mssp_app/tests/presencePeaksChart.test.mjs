import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeaksGeometry,
  createSecretTapGesture,
} from "../public/js/community/presencePeaksChart.js";

test("secret tap gesture unlocks after five quick taps and resets on gaps", () => {
  let now = 1_000;
  const tap = createSecretTapGesture({
    tapsRequired: 5,
    gapMs: 650,
    now: () => now,
  });

  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), true);

  now += 100;
  assert.equal(tap(), false);
  now += 800;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), false);
  now += 100;
  assert.equal(tap(), true);
});

test("peaks geometry builds a rising polyline and area path", () => {
  const geometry = buildPeaksGeometry([
    { day: "2026-07-21", peak: 74 },
    { day: "2026-07-22", peak: 84 },
    { day: "2026-07-23", peak: 40 },
  ], { width: 220, height: 72, pad: 10 });

  assert.equal(geometry.max, 84);
  assert.equal(geometry.dots.length, 3);
  assert.ok(geometry.points.includes(","));
  assert.ok(geometry.area.startsWith("M "));
  assert.ok(geometry.area.endsWith("Z"));
  assert.ok(geometry.dots[1].y < geometry.dots[0].y);
  assert.ok(geometry.dots[2].y > geometry.dots[1].y);
  assert.deepEqual(geometry.labels.map((label) => label.text), ["7/21", "7/22", "7/23"]);
});
