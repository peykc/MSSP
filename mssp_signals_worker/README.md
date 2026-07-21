# MSSP Community Signals Worker

An isolated Cloudflare Worker for anonymous global episode stars, unique episode view counts, and a global DAWGS ONLINE presence count. It does not proxy or receive audio URLs, Patreon RSS URLs, emails, usernames, or page metadata.

Raw browser UUIDs are accepted at the API boundary, validated, immediately hashed as `SHA-256(CLIENT_HASH_SALT + ":" + clientId)`, and never stored or logged. Only the resulting `client_hash` reaches D1 or Durable Object storage.

## API

- `GET /v1/health`
- `POST /v1/stars/toggle`
- `GET /v1/stars/counts?episode=<key>&episode=<key>`
- `POST /v1/views/record`
- `GET /v1/views/counts?episode=<key>&episode=<key>`
- `POST /v1/visitors/record`
- `GET /v1/visitors/total`
- `POST /v1/presence/heartbeat`
- `GET /v1/presence/online`
- `GET /v1/presence/peaks`

All public responses use JSON, `Cache-Control: no-store`, and strict origin checks for `https://peykc.github.io` plus HTTP localhost/loopback development origins. Repeated `episode` parameters are deduplicated; a request may contain at most 20 unique known keys.

The heartbeat and online endpoints return the current `online` count plus the all-time record: `peak` (highest concurrent count ever observed) and `peakAt` (ISO 8601 UTC moment it was set, `null` until the first heartbeat). The records live in the presence Durable Object's SQLite storage, so they survive Worker deploys and restarts and are never reset automatically.

`GET /v1/presence/peaks` additionally returns the graph-ready history: the all-time `peak`/`peakAt` plus `days`, an ascending array of `{ day, peak, peakAt }` with one entry per UTC day (`day` is `YYYY-MM-DD`). Days are only recorded while at least one client is online, so a missing day means zero concurrent users. The first daily row was backfilled from the all-time record's day when the feature deployed. Check the record anytime:

```powershell
Invoke-RestMethod -Method Get `
  -Uri 'https://msspsignal.pkcollection.net/v1/presence/online' `
  -Headers @{ Origin = 'https://peykc.github.io' }
```

## Local setup

Install dependencies and regenerate the catalog after `episodes.json` changes:

```powershell
npm install
npm run catalog:generate
```

Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the ID returned by the D1 creation command before remote operations. For local development, create an untracked `.dev.vars` file containing a strong random value:

```text
CLIENT_HASH_SALT="replace-with-a-long-random-secret"
```

Apply the schema before the catalog seed:

```powershell
npm run db:migrate:local
npm run db:seed:local
npm test
npm run dev
```

The schema must exist before seeding, and the catalog must be seeded before favorite writes can succeed.

## First remote deployment

Authenticate Wrangler, create D1, and copy the returned database ID into `wrangler.jsonc`:

```powershell
npx wrangler login
npx wrangler d1 create mssp-signals-db
```

Then migrate and seed before enabling write traffic:

```powershell
npm run db:migrate:remote
npm run db:seed:remote
npx wrangler secret put CLIENT_HASH_SALT
npm run deploy
```

`wrangler secret put` may create and deploy a Worker version, so it intentionally comes after the remote schema and catalog seed. `CLIENT_HASH_SALT` is declared in `secrets.required`; deployment fails clearly when it has not been configured.

Verify the deployment with its real `workers.dev` URL:

```powershell
Invoke-RestMethod -Method Get `
  -Uri 'https://mssp-signals.<YOUR_SUBDOMAIN>.workers.dev/v1/health' `
  -Headers @{ Origin = 'https://peykc.github.io' }
```

## Updating the episode catalog

The generated JavaScript set rejects fake episode keys before D1 or Durable Object access. The generated SQL seed supplies D1 foreign-key validation. Update them together:

```powershell
npm run catalog:generate
npm run catalog:check
npm run db:seed:remote
npm run deploy
```

Catalog seeding is additive and idempotent; historical keys are not deleted automatically.

## Production abuse controls

CORS is browser policy, not authentication. Write and heartbeat routes are rate-limited in-Worker via Cloudflare Rate Limiting bindings keyed by `client_hash` (never by IP or user-agent):

- `WRITE_RATE_LIMITER` — 30 / 60s for `/v1/stars/toggle`, `/v1/views/record`, and `/v1/visitors/record`
- `HEARTBEAT_RATE_LIMITER` — 12 / 60s for `/v1/presence/heartbeat`

Exceeded limits return `429` with `Retry-After: 60`. Count/read endpoints stay unlimited at the app layer so archive scrolls remain responsive; add Cloudflare WAF/rate-limit rules on the custom domain if those need edge protection too.

## Client polling (expected load)

The app is intentionally chatty-light:

- Presence heartbeat about every **2 minutes** while a tab is visible (or audio is playing). Server TTL is **5 minutes**, so a closed tab can linger online briefly.
- Online count updates come from heartbeat responses (plus a visibility nudge). There is no separate periodic `/v1/presence/online` poll.
- Episode star/view counts refresh on focus/network resume and when the tracked episode window changes, not on a background timer.
