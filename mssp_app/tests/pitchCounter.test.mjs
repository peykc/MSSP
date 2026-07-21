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
  assert.deepEqual(transforms(root), ["translateY(-500%)", "translateY(-200%)"]);

  counter.setValue(51, { animate: true });
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].style.transform, "translateY(-500%)");
  assert.equal(root.children[1].style.transform, "translateY(-200%)");
  assert.ok(frames.length >= 1);

  frames.shift()();
  frames.shift()();
  assert.deepEqual(transforms(root), ["translateY(-500%)", "translateY(-100%)"]);
  assert.equal(root.children[0].classList.values.has("is-instant"), true);
  assert.equal(root.children[1].classList.values.has("is-instant"), false);
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
  assert.deepEqual(transforms(root), ["translateY(-400%)", "translateY(-900%)"]);

  frames.shift()();
  frames.shift()();
  assert.deepEqual(transforms(root), ["translateY(-500%)", "translateY(-100%)"]);
  assert.equal(root.children[0].classList.values.has("is-instant"), false);
  assert.equal(root.children[1].classList.values.has("is-instant"), false);
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
    "translateY(-900%)",
    "translateY(-0%)",
    "translateY(-0%)",
  ]);
  counter.destroy();
});

function transforms(root) {
  return [...root.children].map((column) => column.style.transform);
}

function createRoot() {
  const children = [];
  return {
    children,
    textContent: "",
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
