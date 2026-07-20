# MSSP Community Signals Worker

An isolated Cloudflare Worker for anonymous global episode stars, unique episode view counts, and a global DAWGS ONLINE presence count. It does not proxy or receive audio URLs, Patreon RSS URLs, emails, usernames, or page metadata.

Raw browser UUIDs are accepted at the API boundary, validated, immediately hashed as `SHA-256(CLIENT_HASH_SALT + ":" + clientId)`, and never stored or logged. Only the resulting `client_hash` reaches D1 or Durable Object storage.

## API

- `GET /v1/health`
- `POST /v1/stars/toggle`
- `GET /v1/stars/counts?episode=<key>&episode=<key>`
- `POST /v1/views/record`
- `GET /v1/views/counts?episode=<key>&episode=<key>`
- `POST /v1/presence/heartbeat`
- `GET /v1/presence/online`

All public responses use JSON, `Cache-Control: no-store`, and strict origin checks for `https://peykc.github.io` plus HTTP localhost/loopback development origins. Repeated `episode` parameters are deduplicated; a request may contain at most 20 unique known keys.

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

CORS is browser policy, not authentication. When the Worker is attached to a Cloudflare custom domain, configure Cloudflare rate-limiting rules for `/v1/stars/toggle`, `/v1/views/record`, and `/v1/presence/heartbeat`, with separate, more generous limits for the count endpoints. Rate-limit at Cloudflare's edge; do not add IP addresses or user-agent strings to application storage or logs.
