import assert from "node:assert/strict";
import test from "node:test";

import { createPitchCounter } from "../public/js/community/pitchCounter.js";

test("only changed digits animate on single-digit updates", () => {
  const root = createRoot();
  const frames = [];
  const counter = createPitchCounter(root, {
    preferReducedMotion: () => false,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });

  counter.setValue(52);
  assert.deepEqual(transforms(root), ["translateY(-5em)", "translateY(-2em)"]);

  counter.setValue(51, { animate: true });
  assert.equal(root.children.length, 2);
  assert.equal(reel(root, 0).style.transform, "translateY(-5em)");
  assert.equal(reel(root, 1).style.transform, "translateY(-2em)");
  assert.ok(frames.length >= 1);

  frames.shift()();
  void root.offsetHeight;
  frames.shift()();
  assert.deepEqual(transforms(root), ["translateY(-5em)", "translateY(-1em)"]);
  assert.equal(reel(root, 0).classList.values.has("is-instant"), true);
  assert.equal(reel(root, 1).classList.values.has("is-instant"), false);
  counter.destroy();
});

test("multiple changed digits all animate", () => {
  const root = createRoot();
  const frames = [];
  const counter = createPitchCounter(root, {
    preferReducedMotion: () => false,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });

  counter.setValue(49);
  counter.setValue(51, { animate: true });
  assert.deepEqual(transforms(root), ["translateY(-4em)", "translateY(-9em)"]);

  frames.shift()();
  void root.offsetHeight;
  frames.shift()();
  assert.deepEqual(transforms(root), ["translateY(-5em)", "translateY(-1em)"]);
  assert.equal(reel(root, 0).classList.values.has("is-instant"), false);
  assert.equal(reel(root, 1).classList.values.has("is-instant"), false);
  counter.destroy();
});

test("pitch counter ignores repeat values during animation", () => {
  const root = createRoot();
  const frames = [];
  const counter = createPitchCounter(root, {
    preferReducedMotion: () => false,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });

  counter.setValue(10);
  counter.setValue(19, { animate: true });
  const pending = frames.length;
  counter.setValue(19, { animate: true });
  assert.equal(frames.length, pending);
  counter.destroy();
});

test("pitch counter respects reduced motion", () => {
  const root = createRoot();
  const counter = createPitchCounter(root, {
    preferReducedMotion: () => true,
    requestFrame: () => {
      throw new Error("should not animate");
    },
  });
  counter.setValue(3);
  counter.setValue(900);
  assert.deepEqual(
    [...root.children].map((column) => column.dataset.value),
    ["9", "0", "0"],
  );
  assert.deepEqual(transforms(root), [
    "translateY(-9em)",
    "translateY(0em)",
    "translateY(0em)",
  ]);
  counter.destroy();
});

function reel(root, index) {
  return root.children[index].firstElementChild;
}

function transforms(root) {
  return [...root.children].map((column) => column.firstElementChild.style.transform);
}

function createRoot() {
  const children = [];
  return {
    children,
    textContent: "",
    offsetHeight: 1,
    replaceChildren(...nodes) {
      children.length = 0;
      this.textContent = "";
      for (const node of nodes) {
        node.parent = this;
        children.push(node);
      }
    },
    append(node) {
      node.parent = this;
      children.push(node);
      this.textContent = "";
    },
    get firstElementChild() {
      return children[0] || null;
    },
  };
}

globalThis.document = {
  createElement() {
    const children = [];
    const classValues = new Set();
    const dataset = {};
    const node = {
      className: "",
      style: {},
      children,
      textContent: "",
      parent: null,
      dataset,
      classList: {
        values: classValues,
        add(value) { classValues.add(value); },
        remove(value) { classValues.delete(value); },
        toggle(value, force) {
          if (force) classValues.add(value);
          else classValues.delete(value);
        },
      },
      setAttribute() {},
      append(...nodes) {
        for (const child of nodes) {
          child.parent = node;
          children.push(child);
        }
      },
      get firstElementChild() {
        return children[0] || null;
      },
      remove() {
        if (!node.parent?.children) return;
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      },
    };
    return node;
  },
};
