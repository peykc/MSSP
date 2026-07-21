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
        CREATE TABLE IF NOT EXISTS presence_stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          peak_online INTEGER NOT NULL,
          peak_at INTEGER
        );
        INSERT OR IGNORE INTO presence_stats (id, peak_online, peak_at)
        VALUES (1, 0, NULL);
        CREATE TABLE IF NOT EXISTS daily_peaks (
          day TEXT PRIMARY KEY,
          peak_online INTEGER NOT NULL,
          peak_at INTEGER NOT NULL
        );
      `);
      this.sql.exec(`
        INSERT OR IGNORE INTO daily_peaks (day, peak_online, peak_at)
        SELECT strftime('%Y-%m-%d', peak_at / 1000, 'unixepoch'), peak_online, peak_at
        FROM presence_stats
        WHERE id = 1 AND peak_online > 0 AND peak_at IS NOT NULL
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
    if (url.pathname === "/peaks" && request.method === "GET") {
      return this.handlePeaks();
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

    return internalJson(this.snapshotPresence(now));
  }

  handleCount() {
    return internalJson(this.snapshotPresence(Date.now()));
  }

  snapshotPresence(now) {
    this.deleteExpired(now);
    const online = this.countOnline();
    this.sql.exec(
      `UPDATE presence_stats
       SET peak_online = ?, peak_at = ?
       WHERE id = 1 AND peak_online < ?`,
      online,
      now,
      online,
    );
    if (online > 0) {
      this.sql.exec(
        `INSERT INTO daily_peaks (day, peak_online, peak_at)
         VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           peak_online = excluded.peak_online,
           peak_at = excluded.peak_at
         WHERE excluded.peak_online > daily_peaks.peak_online`,
        utcDayKey(now),
        online,
        now,
      );
    }
    const stats = this.sql.exec(
      "SELECT peak_online, peak_at FROM presence_stats WHERE id = 1",
    ).one();
    return {
      online,
      peak: normalizeCount(stats?.peak_online),
      peakAt: toEpochMs(stats?.peak_at),
    };
  }

  handlePeaks() {
    const stats = this.sql.exec(
      "SELECT peak_online, peak_at FROM presence_stats WHERE id = 1",
    ).one();
    const days = [...this.sql.exec(
      "SELECT day, peak_online, peak_at FROM daily_peaks ORDER BY day",
    )].map((row) => ({
      day: String(row.day),
      peak: normalizeCount(row.peak_online),
      peakAt: toEpochMs(row.peak_at),
    }));
    return internalJson({
      peak: normalizeCount(stats?.peak_online),
      peakAt: toEpochMs(stats?.peak_at),
      days,
    });
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

function toEpochMs(value) {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

function utcDayKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
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
