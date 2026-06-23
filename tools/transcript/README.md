# MSSP Transcribe v2 (portable)

Copy this **entire folder** into any directory that contains episode audio. Paths are relative to this folder — no `-i` / `-o` needed.

## Layout after copy

```
YourAudioFolder/
  2016-11-16 MSSPOT Ep. 1 - ....mp3
  ...
  Transcription/
    transcribe.py
    cache_manager.py
    speaker_assignment.py
    speaker_analyzer.py
    turn_builder.py
    row_builder.py
    diagnostics_v2.py
    .cache/transcripts/     # stage cache (created on first run)
    gen/                    # Pass 1 transcripts (large-v3-turbo default)
    gen-turbo/              # optional isolated turbo output
    gen-large-v3/           # Pass 2 large-v3 reruns
      index.json
      qa-report.json        # optional (--qa-report)
      {episode-stem}.json
```

## Pipeline (v1.2)

```
Audio
  → WhisperX ASR (float16 on CUDA, VAD via transcribe settings)
  → forced alignment (word timings)
  → pyannote diarization (full audio, not VAD chunks)
  → word speaker assignment scores
  → adaptive speaker analysis + smoothing preset
  → canonical speechTurns[]
  → display segments[] (player UI)
```

The player still consumes `segments[]` only. New layers: `diarizationSegments[]`, `speechTurns[]`, enriched `wordSegments[]`.

## One-time setup

Same as v1 — see `setup.bat`. Python 3.10–3.12, CUDA PyTorch, whisperx, `HF_TOKEN` in `.env` for `--diarize`.

## Run

Double-click launchers (v2 pipeline, model-aware output folders):

| Launcher | Model | Output folder | Use |
|----------|-------|---------------|-----|
| `transcribe.bat` | large-v3-turbo | `gen/` | Default Pass 1 batch (same as `transcribe_v2.bat`) |
| `transcribe_v2.bat` | large-v3-turbo | `gen/` | Explicit v2 Pass 1 baseline |
| `transcribe_v2_turbo.bat` | large-v3-turbo | `gen-turbo/` | Turbo runs isolated from `gen/` |
| `transcribe_v2_large_v3.bat` | large-v3 | `gen-large-v3/` | Pass 2 quality reruns |

```powershell
.\transcribe.bat
.\transcribe_v2.bat
.\transcribe_v2_turbo.bat
.\transcribe_v2_large_v3.bat --only "bad-episode.mp3" --force-asr
.\transcribe.ps1
python transcribe.py --diarize
```

Defaults (v2):
- ASR: `large-v3-turbo`, `float16` on CUDA
- Speakers: exploratory `min=2`, `max=8`, `--speaker-mode adaptive`
- Row strategy: `speaker-turn-v2`
- Cache: `.cache/transcripts/` with schema `transcript-cache-v2.0`
- Skip-by-default: existing `gen/*.json` are not regenerated unless forced

## Cache / rebuild commands

```powershell
# Rebuild turns + display rows from cached diarization (no ASR/GPU)
python transcribe.py --only "episode.mp3" --rebuild-turns-only

# Rebuild display rows only from cached speechTurns
python transcribe.py --only "episode.mp3" --rebuild-rows-only

# Force single stages
python transcribe.py --only "episode.mp3" --force-diarize --force-turns
```

## Key flags

| Flag | Default | Notes |
|------|---------|--------|
| `--speaker-mode` | `adaptive` | `normal` / `group` / `chaotic` / `forced-two-host` |
| `--min-speakers` / `--max-speakers` | 2 / 8 | Exploratory diarization bounds |
| `--num-speakers` | off | **Only** with `forced-two-host` (explicit 2-host rerun) |
| `--asr-compute-type` | `float16` (CUDA) | Fallback: `int8_float16`, `int8`, CPU |
| `--reuse-cache` / `--no-cache` | on / off | Stage cache in `.cache/transcripts/` |
| `--cache-version` | `transcript-cache-v2.0` | Reject stale cache envelopes |
| `--rebuild-turns-only` | off | Rebuild turns/rows from cache |
| `--qa-report` | off | Write `gen/qa-report.json` after batch |

## Batch strategy (900 episodes)

**Pass 1** — baseline batch:
```powershell
python transcribe.py --diarize --speaker-mode adaptive --reuse-cache
```

**Pass 2** — rerun flagged episodes from `gen/index.json` / `qa-report.json`:
```powershell
python transcribe.py --only "bad-episode.mp3" --model large-v3 --force-asr --speaker-mode chaotic
```

**Pass 3** — manual QA on worst episodes via `test/review.html` + `test/score_speakers.py`.

**Acceptance (25 episodes):** after Pass 1, rebuild with `--rebuild-turns-only`, then compare manifests:
```powershell
python test/compare_manifest.py gen/index-v1.1-backup.json gen/index.json --limit 25
```

## QA tools

- `test/review.html` — toggle `segments` vs `speechTurns` review layer; shows assignment scores
- `test/score_speakers.py` — score candidate JSON against exported corrections (overlap-weighted)

6GB GPU: ASR CUDA (float16), align CPU, diarize CUDA (automatic).
