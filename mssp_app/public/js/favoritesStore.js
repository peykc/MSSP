const STORAGE_KEY = "mssp:favorites";

export function createFavoritesStore() {
  const listeners = new Set();
  let keys = readKeys();

  function getKeys() {
    return new Set(keys);
  }

  function getCount() {
    return keys.size;
  }

  function has(episodeOrKey) {
    return keys.has(getKey(episodeOrKey));
  }

  function toggle(episodeOrKey) {
    const key = getKey(episodeOrKey);
    if (!key) return false;
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    persist();
    notify();
    return keys.has(key);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getKeys());
    return () => listeners.delete(listener);
  }

  function retain(validKeys) {
    const nextKeys = new Set([...keys].filter((key) => validKeys.has(key)));
    if (nextKeys.size === keys.size) return;
    keys = nextKeys;
    persist();
    notify();
  }

  function notify() {
    for (const listener of listeners) listener(getKeys());
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
    } catch (error) {
      console.warn("[MSSP] Could not persist favorites; using memory for this session.", error);
    }
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    keys = readKeys();
    notify();
  });

  return {
    getCount,
    getKeys,
    has,
    retain,
    subscribe,
    toggle,
  };
}

function getKey(episodeOrKey) {
  if (typeof episodeOrKey === "string") return episodeOrKey;
  return String(episodeOrKey?.episodeKey || "");
}

function readKeys() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}
