# MSSP Transcribe v2 (portable)

Copy this folder into your local audio/transcript workspace. Paths are relative to this folder — no `-i` / `-o` needed for the normal runners.

## Kept launchers

This repo intentionally keeps only the two v2 runners you actually use:

| Launcher | Model | Output folder | Use |
|---|---|---|---|
| `transcribe_v2_large_v3.bat` | `large-v3` | `gen-large-v3/` | Main quality run |
| `transcribe_v2_turbo.bat` | `large-v3-turbo` | `gen-turbo/` | Faster fallback / preview run |

Both launchers use the same v2 behavior:

- `--language en`
- `--batch-size 1`
- `--diarize`
- `--speaker-mode adaptive`
- `--reuse-cache`
- `--no-reuse-align-model`
- `--no-reuse-diarize-model`
- `--isolate-per-file`

`--isolate-per-file` is important on 6GB GPUs because it gives each episode a fresh Python/CUDA process and avoids CUDA memory getting poisoned across episodes.

## Typical commands

```powershell
# Main quality run
.\transcribe_v2_large_v3.bat

# Test 5-10 episodes
.\transcribe_v2_large_v3.bat --limit 10

# Faster fallback / preview
.\transcribe_v2_turbo.bat --limit 10

# Single episode
.\transcribe_v2_large_v3.bat --only "2016-11-16 MSSPOT Ep. 1 - Inaugral Business.mp3"

# Rebuild turns/rows from cache after cleanup-rule changes
.\transcribe_v2_large_v3.bat --rebuild-turns-only --limit 10
```

Extra args are passed through to `transcribe.py`.

## Required files

```text
tools/transcript/
  README.md
  requirements.txt
  setup.bat
  .gitignore

  _transcribe_env.bat
  transcribe_v2_large_v3.bat
  transcribe_v2_turbo.bat

  transcribe.py
  cache_manager.py
  diagnostics_v2.py
  pipeline_monitor.py
  presets.py
  row_builder.py
  speaker_analyzer.py
  speaker_assignment.py
  turn_builder.py
  vad.py
```

## Pipeline

```text
Audio
  → WhisperX ASR
  → forced word alignment
  → advisory VAD export / mismatch flags
  → full-audio pyannote diarization
  → word speaker assignment scores
  → adaptive speaker analysis + smoothing preset
  → canonical speechTurns[]
  → display segments[] for the player
```

The player still consumes `segments[]`. The v2 transcript also writes `diarizationSegments[]`, `speechTurns[]`, and enriched `wordSegments[]` for QA/debugging.

## One-time setup

Run:

```bat
setup.bat
```

Requirements:

- Python 3.10–3.12 recommended
- CUDA-capable PyTorch for GPU runs
- WhisperX dependencies
- `HF_TOKEN` in `.env` for diarization

## Cache / rebuild behavior

Stage cache lives in:

```text
.cache/transcripts/
```

Existing JSON outputs are skipped by default unless you force a stage. Use rebuild flags for cheap post-processing changes:

```powershell
.\transcribe_v2_large_v3.bat --rebuild-turns-only --limit 10
.\transcribe_v2_large_v3.bat --rebuild-rows-only --limit 10
```

Use force flags only when needed:

```powershell
.\transcribe_v2_large_v3.bat --only "episode.mp3" --force-diarize
.\transcribe_v2_large_v3.bat --only "episode.mp3" --force-asr
```

## Do not commit runtime output

Keep these out of GitHub:

```text
.venv/
.cache/
gen/
gen-turbo/
gen-large-v3/
__pycache__/
*.pyc
.env
*.log
console.txt
```
