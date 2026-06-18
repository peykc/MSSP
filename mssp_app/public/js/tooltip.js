export function initGlobalTooltip() {
  const tooltip = document.getElementById("global-tooltip");
  if (!tooltip) return null;
  let activeTarget = null;

  function viewportClientBox() {
    const vv = window.visualViewport;
    if (vv) {
      return {
        left: vv.offsetLeft,
        top: vv.offsetTop,
        width: vv.width,
        height: vv.height,
      };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function clampTooltipToViewport(marginPx) {
    const m = marginPx;
    void tooltip.offsetWidth;
    let r = tooltip.getBoundingClientRect();
    let baseLeft = parseFloat(tooltip.style.left);
    let baseTop = parseFloat(tooltip.style.top);
    if (!Number.isFinite(baseLeft)) baseLeft = r.left;
    if (!Number.isFinite(baseTop)) baseTop = r.top;

    for (let pass = 0; pass < 3; pass += 1) {
      const vp = viewportClientBox();
      const minL = vp.left + m;
      const maxR = vp.left + vp.width - m;
      const minT = vp.top + m;
      const maxB = vp.top + vp.height - m;
      let dx = 0;
      let dy = 0;

      if (r.left < minL) dx = minL - r.left;
      else if (r.right > maxR) dx = maxR - r.right;
      if (r.top < minT) dy = minT - r.top;
      else if (r.bottom > maxB) dy = maxB - r.bottom;
      if (!dx && !dy) break;

      baseLeft += dx;
      baseTop += dy;
      tooltip.style.left = `${baseLeft}px`;
      tooltip.style.top = `${baseTop}px`;
      void tooltip.offsetWidth;
      r = tooltip.getBoundingClientRect();
    }
  }

  function dismissGlobalTooltip() {
    tooltip.classList.remove("visible");
    activeTarget = null;
  }

  function showTooltip(targetEl, tipText) {
    activeTarget = targetEl;
    tooltip.textContent = tipText;
    tooltip.classList.add("visible");
    void tooltip.offsetWidth;

    const rect = targetEl.getBoundingClientRect();
    const margin = 10;
    const tipW = tooltip.offsetWidth;
    const tipH = tooltip.offsetHeight;
    const vpBox = viewportClientBox();
    const vpBot = vpBox.top + vpBox.height;
    const place = (targetEl.getAttribute("data-tip-placement") || "").toLowerCase();
    let top;

    if (place === "bottom") {
      top = rect.bottom + margin;
      if (top + tipH > vpBot - margin) top = rect.top - tipH - margin;
    } else {
      top = rect.top - tipH - margin;
      if (top < vpBox.top + margin) top = rect.bottom + margin;
    }

    top = Math.max(vpBox.top + margin, Math.min(top, vpBot - tipH - margin));
    let left = rect.left + rect.width / 2 - tipW / 2;
    const leftMax = vpBox.left + vpBox.width - tipW - margin;
    left = Math.max(vpBox.left + margin, Math.min(left, leftMax));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    clampTooltipToViewport(margin);
  }

  document.addEventListener("mouseover", (event) => {
    let el = event.target;
    if (!el) return;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.closest(".episode-row, .full-player__queue-item, .hero-details .full-player__title")) return;

    let targetEl = el.closest("[data-tip]");
    let tipText = targetEl ? targetEl.getAttribute("data-tip") : null;
    if (!targetEl) {
      const style = window.getComputedStyle(el);
      if (style.textOverflow === "ellipsis" && el.scrollWidth - el.offsetWidth > 2) {
        targetEl = el;
        tipText = el.textContent.trim();
      }
    } else {
      const style = window.getComputedStyle(targetEl);
      if (style.textOverflow === "ellipsis" && targetEl.scrollWidth - targetEl.offsetWidth <= 2) {
        targetEl = null;
        tipText = null;
      }
    }

    if (targetEl && tipText) showTooltip(targetEl, tipText);
  });

  document.addEventListener("mouseout", (event) => {
    if (activeTarget && !activeTarget.contains(event.relatedTarget)) {
      dismissGlobalTooltip();
    }
  });
  document.addEventListener("scroll", dismissGlobalTooltip, true);
  document.addEventListener("click", dismissGlobalTooltip, true);

  window.MsspAnthology = window.MsspAnthology || {};
  window.MsspAnthology.dismissGlobalTooltip = dismissGlobalTooltip;
  return dismissGlobalTooltip;
}
