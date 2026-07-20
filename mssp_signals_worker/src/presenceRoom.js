export const PRESENCE_TTL_MS = 90_000;
export const GLOBAL_PRESENCE_ROOM = "global";

const CLIENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class PresenceRoom {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    const initialize = async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS online_clients (
          client_hash TEXT PRIMARY KEY,
          last_seen INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_online_clients_last_seen
        ON online_clients (last_seen);
      `);
    };
    this.ready = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(initialize)
      : initialize();
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      return this.handleHeartbeat(request);
    }
    if (url.pathname === "/count" && request.method === "GET") {
      return this.handleCount();
    }
    return internalJson({ error: "not_found" }, 404);
  }

  async handleHeartbeat(request) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return internalJson({ error: "invalid_json" }, 400);
    }

    if (!isExactObject(payload, ["clientHash", "online"])
      || !CLIENT_HASH_PATTERN.test(payload.clientHash)
      || typeof payload.online !== "boolean") {
      return internalJson({ error: "invalid_payload" }, 400);
    }

    const now = Date.now();
    this.deleteExpired(now);
    if (payload.online) {
      this.sql.exec(
        `INSERT INTO online_clients (client_hash, last_seen)
         VALUES (?, ?)
         ON CONFLICT(client_hash) DO UPDATE SET
           last_seen = excluded.last_seen`,
        payload.clientHash,
        now,
      );
    } else {
      this.sql.exec("DELETE FROM online_clients WHERE client_hash = ?", payload.clientHash);
    }

    return internalJson({ online: this.countOnline() });
  }

  handleCount() {
    this.deleteExpired(Date.now());
    return internalJson({ online: this.countOnline() });
  }

  deleteExpired(now) {
    this.sql.exec("DELETE FROM online_clients WHERE last_seen <= ?", now - PRESENCE_TTL_MS);
  }

  countOnline() {
    const row = this.sql.exec(
      "SELECT COUNT(*) AS count FROM online_clients",
    ).one();
    return normalizeCount(row?.count);
  }
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function isExactObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function internalJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
