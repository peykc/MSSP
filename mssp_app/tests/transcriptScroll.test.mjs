import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/player/transcriptView.js', import.meta.url), 'utf8');
// Run the actual layout functions with a controlled scheduler so a measurement
// lands precisely inside a smooth scroll, rather than relying on timer luck.
function loadFunction(name, context) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInNewContext(`${source.slice(start, end)}\n${name}();`, context);
}
function hydrationHarness(scrolling) {
  let cursor = 0;
  const calls = [];
  return {
    calls,
    hydrateToken: 1, modeActive: true, timeline: [{}], availability: 'available',
    AVAILABILITY: { AVAILABLE: 'available' }, HYDRATE_BATCH_SIZE: 24,
    entryHeights: [200], entryMeasured: [false], deferredHeightUpdates: new Map(),
    dom: { fullPlayerTranscriptViewport: { classList: { contains: () => scrolling } } },
    nextUnmeasuredHydrateIndex: () => cursor++ === 0 ? 0 : -1,
    measureEntryHeightDom: () => 80,
    captureScrollAnchor: () => ({}),
    rebuildEntryOffsets: () => calls.push('offsets'),
    updateSpacerHeight: () => calls.push('spacer'),
    reconcileScrollAfterLayoutChange: () => calls.push('scroll'),
    repositionMountedEntries: () => calls.push('positions'),
    scheduleRenderVisibleEntries: () => calls.push('render'),
  };
}
test('background measurement never rewrites layout or interrupts a smooth scroll', () => {
  const context = hydrationHarness(true);
  loadFunction('runHeightHydrationBatch', context);
  assert.equal(context.entryHeights[0], 200);
  assert.equal(context.entryMeasured[0], false);
  assert.equal(context.deferredHeightUpdates.get(0), 80);
  assert.deepEqual(context.calls, []);
});
test('background measurement updates layout when no smooth scroll is running', () => {
  const context = hydrationHarness(false);
  loadFunction('runHeightHydrationBatch', context);
  assert.equal(context.entryHeights[0], 80);
  assert.equal(context.entryMeasured[0], true);
  assert.ok(context.calls.includes('scroll'));
});
test('smooth scroll completion recenters even without queued measurements', () => {
  let complete;
  const calls = [];
  const context = {
    dom: { fullPlayerTranscriptViewport: {
      clientHeight: 500,
      classList: { add() {}, remove: () => calls.push('unlock') },
      scrollTo: () => calls.push('smooth'),
    } },
    programmaticScrollTimer: null,
    getCenteredScrollTop: () => 200,
    window: { clearTimeout() {}, matchMedia: () => ({ matches: false }), setTimeout: fn => { complete = fn; } },
    scheduleRenderVisibleEntries() {},
    flushDeferredHeightUpdates: () => calls.push('flush'),
    shouldMaintainFollowScroll: () => true,
    maintainFollowScroll: ({ instant }) => { assert.equal(instant, true); calls.push('center'); },
  };
  const start = source.indexOf('  function scrollToElement(');
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInNewContext(`${source.slice(start, end)}\nscrollToElement({});`, context);
  complete();
  assert.deepEqual(calls, ['smooth', 'unlock', 'flush', 'center']);
});
