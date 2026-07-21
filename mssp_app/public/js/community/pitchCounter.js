export function createPitchCounter(root, {
  preferReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
} = {}) {
  if (!root) throw new Error("Pitch counter requires a root element");

  let value = null;
  let frameId = null;

  function setValue(next, { animate = true } = {}) {
    if (!Number.isFinite(next) || next < 0) {
      cancelPending();
      value = null;
      root.replaceChildren();
      root.textContent = "—";
      return;
    }

    const to = Math.floor(next);
    if (to === value) return;

    const previous = value;
    value = to;

    if (root.textContent === "—") root.textContent = "";

    const canAnimate = animate
      && previous !== null
      && previous !== to
      && !preferReducedMotion();

    cancelPending();
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
      const reel = column.firstElementChild;
      const digit = nextDigits[index];
      const lengthOffset = nextDigits.length - previousDigits.length;
      const previousIndex = index - lengthOffset;
      const previousDigit = previousIndex >= 0 && previousIndex < previousDigits.length
        ? previousDigits[previousIndex]
        : 0;
      const changed = previous === null || previousDigit !== digit;

      if (!reel) continue;

      if (!animate || !changed) {
        setReelDigit(column, reel, digit, { instant: true });
        continue;
      }

      setReelDigit(column, reel, previousDigit, { instant: true });
      pending.push({ column, reel, digit });
    }

    if (!pending.length) return;

    frameId = requestFrame(() => {
      void root.offsetHeight;
      frameId = requestFrame(() => {
        frameId = null;
        for (const item of pending) {
          setReelDigit(item.column, item.reel, item.digit, { instant: false });
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
    column.className = "pitch-counter__digit";
    column.dataset.value = "0";
    column.setAttribute("aria-hidden", "true");

    const reel = document.createElement("span");
    reel.className = "pitch-counter__reel is-instant";
    reel.style.transform = "translateY(0em)";

    for (let digit = 0; digit <= 9; digit += 1) {
      const slot = document.createElement("span");
      slot.className = "pitch-counter__slot";
      slot.textContent = String(digit);
      reel.append(slot);
    }

    column.append(reel);
    return column;
  }

  function setReelDigit(column, reel, digit, { instant }) {
    column.dataset.value = String(digit);
    reel.classList.toggle("is-instant", instant);
    reel.style.transform = `translateY(${-digit}em)`;
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
