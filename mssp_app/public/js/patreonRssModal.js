export function createPatreonRssModal({ dom, patreonSources, getEpisodes, onSourcesChanged }) {
  let restoreFocusTo = null;
  let busy = false;

  function open(trigger = document.activeElement) {
    restoreFocusTo = trigger;
    const storedUrl = patreonSources.getStoredUrl();
    const connected = patreonSources.isConnected();
    const hasConnection = connected || Boolean(storedUrl);
    dom.patreonRssInput.value = storedUrl;
    dom.patreonRssRemember.checked = storedUrl ? true : !connected;
    setRevealed(false);
    setStatus("");
    dom.patreonRssTitle.textContent = hasConnection ? "Manage Patreon RSS" : "Connect Patreon RSS";
    dom.patreonRssSubmit.textContent = hasConnection ? "Replace" : "Connect";
    dom.patreonRssRemove.hidden = !hasConnection;
    dom.patreonRssModal.hidden = false;
    dom.patreonRssModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("patreon-rss-open");
    requestAnimationFrame(() => dom.patreonRssInput.focus());
  }

  function close() {
    if (busy || dom.patreonRssModal.hidden) return;
    dom.patreonRssModal.hidden = true;
    dom.patreonRssModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("patreon-rss-open");
    dom.patreonRssInput.value = "";
    setStatus("");
    restoreFocusTo?.focus?.();
    restoreFocusTo = null;
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus("Connecting through the MSSP RSS Worker…");
    try {
      const result = await patreonSources.connect(dom.patreonRssInput.value, getEpisodes(), {
        persist: dom.patreonRssRemember.checked,
      });
      await onSourcesChanged();
      dom.patreonRssTitle.textContent = "Patreon RSS connected";
      dom.patreonRssSubmit.textContent = "Replace";
      dom.patreonRssRemove.hidden = false;
      setStatus(`${result.matched} of ${result.eligibleEpisodes} PAYTCH episodes unlocked. ${result.unmatchedEpisodes} still need a match.`, "success");
    } catch (error) {
      setStatus(error?.name === "PatreonRssConnectionError" ? error.message : "The private RSS connection could not be completed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      patreonSources.disconnect();
      await onSourcesChanged();
      dom.patreonRssInput.value = "";
      dom.patreonRssTitle.textContent = "Connect Patreon RSS";
      dom.patreonRssSubmit.textContent = "Connect";
      dom.patreonRssRemove.hidden = true;
      dom.patreonRssRemember.checked = true;
      setStatus("Private RSS connection removed from this browser.", "success");
    } catch (error) {
      setStatus(error?.message || "The private RSS connection could not be removed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value) {
    busy = Boolean(value);
    dom.patreonRssInput.disabled = busy;
    dom.patreonRssRemember.disabled = busy;
    dom.patreonRssReveal.disabled = busy;
    dom.patreonRssSubmit.disabled = busy;
    dom.patreonRssCancel.disabled = busy;
    dom.patreonRssRemove.disabled = busy;
    dom.patreonRssSubmit.textContent = busy ? "Connecting…" : (patreonSources.isConnected() ? "Replace" : "Connect");
  }

  function setStatus(message, kind = "") {
    dom.patreonRssStatus.textContent = message;
    dom.patreonRssStatus.classList.toggle("is-error", kind === "error");
    dom.patreonRssStatus.classList.toggle("is-success", kind === "success");
  }

  function setRevealed(revealed) {
    dom.patreonRssInput.type = revealed ? "url" : "password";
    dom.patreonRssReveal.textContent = revealed ? "Hide" : "Show";
    dom.patreonRssReveal.setAttribute("aria-label", `${revealed ? "Hide" : "Show"} private RSS link`);
    dom.patreonRssReveal.setAttribute("aria-pressed", String(revealed));
  }

  function onKeydown(event) {
    if (dom.patreonRssModal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dom.patreonRssDialog.querySelectorAll("button:not([disabled]):not([hidden]), input:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dom.patreonRssLogoButton.addEventListener("click", (event) => open(event.currentTarget));
  dom.patreonRssForm.addEventListener("submit", submit);
  dom.patreonRssReveal.addEventListener("click", () => setRevealed(dom.patreonRssInput.type === "password"));
  dom.patreonRssClose.addEventListener("click", close);
  dom.patreonRssCancel.addEventListener("click", close);
  dom.patreonRssRemove.addEventListener("click", remove);
  dom.patreonRssModal.addEventListener("click", (event) => {
    if (event.target === dom.patreonRssModal) close();
  });
  document.addEventListener("keydown", onKeydown);

  return { close, open };
}
