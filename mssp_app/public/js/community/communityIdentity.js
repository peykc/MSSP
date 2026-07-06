const STORAGE_KEY = "mssp:community-client-id";

let memoryClientId = "";

export function getCommunityClientId({
  storage = globalThis.localStorage,
  cryptoApi = globalThis.crypto,
} = {}) {
  if (memoryClientId) return memoryClientId;

  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (typeof stored === "string" && stored) {
      memoryClientId = stored;
      return memoryClientId;
    }
  } catch {
    // Fall through to a session-only identifier.
  }

  if (!cryptoApi?.randomUUID) {
    throw new Error("Secure UUID generation is unavailable");
  }
  memoryClientId = cryptoApi.randomUUID();
  try {
    storage?.setItem(STORAGE_KEY, memoryClientId);
  } catch {
    // The in-memory identifier remains valid for this page session.
  }
  return memoryClientId;
}
