export function createPitchCounter(root, {
  preferReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
} = {}) {
  if (!root) throw new Error("Pitch counter requires a root element");

  let value = null;
  let frameId = null;

  function setValue(next, { animate = true } = {}) {
    cancelPending();

    if (!Number.isFinite(next) || next < 0) {
      value = null;
      root.replaceChildren();
      root.textContent = "—";
      return;
    }

    const to = Math.floor(next);
    const previous = value;
    value = to;

    if (root.textContent === "—") root.textContent = "";

    const canAnimate = animate && previous !== null && previous !== to && !preferReducedMotion();
    paint(to, previous, { animate: canAnimate });
  }

  function getValue() {
    return value;
  }

  function paint(next, previous, { animate }) {
    const nextDigits = String(next).split("").map(Number);
    const previousDigits = previous === null
      ? nextDigits.map(() => 0)
      : String(previous).split("").map(Number);

    syncColumnCount(nextDigits.length);

    const columns = [...root.children];
    const pending = [];

    for (let index = 0; index < nextDigits.length; index += 1) {
      const column = columns[index];
      const digit = nextDigits[index];
      const lengthOffset = nextDigits.length - previousDigits.length;
      const previousIndex = index - lengthOffset;
      const previousDigit = previousIndex >= 0 && previousIndex < previousDigits.length
        ? previousDigits[previousIndex]
        : 0;
      const changed = previous === null || previousDigit !== digit;

      if (!animate || !changed) {
        setColumnDigit(column, digit, { instant: true });
        continue;
      }

      // Restart the reel at the previous digit, then ease to the new one.
      setColumnDigit(column, previousDigit, { instant: true });
      pending.push({ column, digit });
    }

    if (!pending.length) return;

    frameId = requestFrame(() => {
      frameId = requestFrame(() => {
        frameId = null;
        for (const item of pending) {
          setColumnDigit(item.column, item.digit, { instant: false });
        }
      });
    });
  }

  function syncColumnCount(count) {
    while (root.children.length < count) {
      root.append(createDigitColumn());
    }
    while (root.children.length > count) {
      root.firstElementChild?.remove();
    }
  }

  function createDigitColumn() {
    const column = document.createElement("span");
    column.dataset.value = "0";
    column.setAttribute("aria-hidden", "true");
    column.classList.add("is-instant");
    column.style.transform = "translateY(0%)";

    for (let digit = 0; digit <= 9; digit += 1) {
      const slot = document.createElement("span");
      slot.textContent = String(digit);
      column.append(slot);
    }

    return column;
  }

  function setColumnDigit(column, digit, { instant }) {
    column.dataset.value = String(digit);
    column.classList.toggle("is-instant", instant);
    column.style.transform = `translateY(-${digit * 100}%)`;
  }

  function cancelPending() {
    if (frameId === null) return;
    cancelFrame(frameId);
    frameId = null;
  }

  function destroy() {
    cancelPending();
  }

  return { setValue, getValue, destroy };
}
