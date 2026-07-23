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
| `ads` | Local only: `cd mssp_audio_proxy` → `cuts:align` → `cuts:distill` → `cuts:generate` → `deploy` |
| `deploy-workers` | Deploy `mssp_signals_worker` (and audio proxy if you cut promos) |

Then push `main`.
