# Episode Update Guide

## One command

After new episodes are in `data/The Holy Trinity/` (`.txt` + `.md` + `.json`):

```bash
node tools/run_update.mjs
```

Uses `PATREON_RSS_URL` from the environment (GitHub Actions secret, or your shell).

Local XML instead:

```bash
node tools/run_update.mjs --patreon-feed path/to/feed.xml
```

At the end it prints **MANUAL LEFTOVERS** (Megaphone misses, PAYTCH misses, promo-cut reminder, worker deploys).

---

## First-time / new episode prep (before the command)

1. Rename files: `YYYY-MM-DD MSSP Ep. N - Title.mp3`
2. Drop them in `tools/episode-update/update/`
3. Run `python tools/episode-update/update_holy_trinity.py`
4. Copy updated Trinity `.txt` / `.md` / `.json` into `data/The Holy Trinity/`

---

## What the script already does

1. Split OT / NT / PAYTCH (`organizefilepath.py`)
2. Sync episode count expectations
3. Export app data + match Megaphone
4. Audit PAYTCH against your Patreon feed (no audio URLs saved)
5. Regenerate signals catalog
6. Print leftovers

---

## Still manual after leftovers

| Leftover | What to do |
|----------|------------|
| `megaphone-unmatched` | Add guid in `data/source-overrides.public.json`, re-run |
| `paytch-unmatched` | Add guid in `mssp_app/public/data/patreon-rss-overrides.json`, re-run |
| `ads` | See **Megaphone ad cuts** below |
| `deploy-workers` | `cd mssp_signals_worker` → `catalog:generate` → `db:seed:remote` → `deploy` (seed is required or views stay null). Also deploy audio proxy if you cut promos. |
| `transcript search` | See below — **wait until new transcripts are uploaded**, then rebuild the index |

Then push `main`.

---

## Megaphone ad cuts (NT only)

Site NT audio is Megaphone → Cloudflare audio proxy. **DAI mid-rolls strip automatically.** Baked-in end/pre promos need measured cut lists from this pipeline.

Holy Trinity archive (`C:\Users\peyto\Desktop\The Holy Trinity`) must stay **ad-free** — the aligner treats it as ground truth and never modifies those files. Needs `ffprobe` / `ffmpeg` on PATH.

### When to run

- After new NT episodes land (leftover `ads` from `run_update.mjs`), or
- When a live NT ep still plays a baked-in promo at the end

### Checklist (do in order)

1. **Sources current** — `sources.public.json` has the new NT ep(s) with `upstreamUrl` (re-run `node tools/run_update.mjs` or `npm run export:sources` from `mssp_app` if not).
2. **Archive present** — matching ad-free file under Holy Trinity for each new NT ep (same filename as catalog). Prefer Megaphone-matching rips; YouTube `.m4a` often fails correlation.
3. **Align** (from `mssp_audio_proxy`):

```bash
cd mssp_audio_proxy

# Usual update (new eps only): leave .align-work/state.jsonl in place — resume skips done keys.
# Full re-scan (lengths look wrong / mass fix): rename or delete state.jsonl (+ optional progress.txt).

npm run cuts:align
# Optional one-off: node scripts/alignBakedPromos.mjs --only 623,625
```

4. **Review leftovers** — skim `.align-work/progress.txt` for `flag` / `error` / `anomaly-*`. **Do not invent cuts.** Fix archive or hand-cut later.
5. **Ship cuts:**

```bash
npm run cuts:distill    # -> data/baked-promo-cuts.json
npm run cuts:generate   # -> src/generated/bakedPromoCuts.js
```

6. **Bump cache version** — in `src/index.js`, increment `CACHE_KEY_VERSION` (and a one-line comment why). **Required** whenever the cut list changes; otherwise edge cache keeps pre-cut audio for up to 24h.
7. **Deploy proxy:**

```bash
npm run deploy
```

8. **Verify** — HEAD the new ep through the proxy; expect `baked slot(s)` ≥ 1 if it got a `cut`:

```bash
# Example (replace id from sources.public.json url)
curl -I -H "Origin: https://peykc.github.io" https://nt-audio.pkcollection.net/nt/GLT........mp3
# Look for: x-mssp-promos-removed: … + N baked slot(s)
```

Spot-check playback on the live site (seek near the end). Also spot-check one older ep that already had cuts.

### What the statuses mean

| Status | Meaning |
|--------|---------|
| `clean` / `clean-estimated` | Duration matches archive — no baked cut needed |
| `cut` | Verified promo range(s) → goes into baked-promo-cuts |
| `flag` | Looks dirty but alignment didn’t verify — leave alone |
| `error` | Failed (weak corr, bad archive, etc.) — leave alone |
| `anomaly-archive-longer` | Archive longer than public master — leave alone |

### Pitfalls (so next time doesn’t hurt)

- Aligner measures Megaphone **upstream** (post-DAI), **not** the live proxy — never point it at already-cut proxy audio.
- Forgetting `CACHE_KEY_VERSION` bump → deploy “succeeds” but listeners still hear old ads until cache expires.
- Don’t run two `cuts:align` processes at once (corrupts `.align-work` temp files / state).
- Don’t hand-edit byte ranges in `baked-promo-cuts.json` unless you know what you’re doing.
- PAYTCH / OT are out of scope (not Megaphone-proxied).

---

## Transcript search footer (`816/896` etc.)

Not hardcoded. The UI reads `stats` from the search-index manifest on R2:

`transcripts.pkcollection.net/mssp/search-index/v1/manifest.json`

- `episodesWithTranscripts` = how many eps actually have a transcript in the index  
- `episodesTotal` = catalog size when the index was last built  

**Do this after** new episode transcripts are uploaded (rebuilding early just freezes an incomplete count):

```bash
cd mssp_app
npm run build:search-index
```

Then upload `search-index-dist/v1/*` to the transcripts R2 search-index prefix (same place the live manifest lives). Footer becomes `withTranscripts/catalogTotal` from that new build.
