# MSSP Transcribe v2 (portable)

Copy this folder into your local audio/transcript workspace. Paths are relative to this folder — no `-i` / `-o` needed for the normal runners.

## Kept launchers

This repo intentionally keeps only the two v2 runners you actually use:

| Launcher | Model | Output folder | Use |
|---|---|---|---|
| `transcribe_v2_large_v3.bat` | `large-v3` | `gen-large-v3/` | Main quality run |
| `transcribe_v2_turbo.bat` | `large-v3-turbo` | `gen-turbo/` | Faster fallback / preview run |

(`transcribe_v2_parallel.bat` + `transcribe_parallel.py` / `run_parallel.sh` are the multi-GPU rental workflow — see `RENTAL_RUNBOOK.md`.)

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

  cluster_merge.py           # same-voice diarization cluster merging
  acoustic_rescore.py        # voice-based re-scoring of crosstalk spans

  score_transcript.py        # ground-truth scorer
  make_ground_truth_txt.py   # ground-truth annotation tooling
  eval/
    ground-truth/            # hand-labeled benchmark transcripts
```

## Pipeline

```text
Audio
  → WhisperX ASR
  → forced word alignment
  → advisory VAD export / mismatch flags
  → full-audio pyannote diarization
  → cluster merge: same-voice clusters unified via speaker embeddings
  → word speaker assignment scores
  → acoustic rescore: crosstalk spans re-decided by voice similarity
  → adaptive speaker analysis + smoothing preset
  → canonical speechTurns[] (incl. boundary snap at speaker transitions)
  → display segments[] for the player (incl. fragment-row merge)
```

The player still consumes `segments[]`. The v2 transcript also writes `diarizationSegments[]`, `speechTurns[]`, and enriched `wordSegments[]` for QA/debugging. `metadata.clusterMerge` and `metadata.acousticRescore` record what the quality stages did per episode.

## Quality stages (all default ON)

| Stage | What it fixes | Opt out / tune |
|---|---|---|
| Cluster merge | One real speaker split across several `SPEAKER_xx` clusters (embeddings, wespeaker; same-voice pairs score 0.82+, distinct ≤0.67) | `--no-cluster-merge`, `--cluster-merge-threshold 0.70` |
| Acoustic rescore | Words in crosstalk/uncovered regions assigned by time-overlap instead of voice | `--no-acoustic-rescore`, `--acoustic-rescore-margin 0.15` |
| Boundary snap | Speaker transitions cut 1-2 words early/late (previous speaker's sentence-final words on the next speaker's line) | always on (punctuation + pause gated) |
| Fragment-row merge | One phrase shattered across several same-speaker rows mid-sentence | `--no-merge-fragment-rows` |
| Turn-context repair | (measured ineffective — kept as opt-in only) | `--turn-context-repair` |

Cluster centroids are cached inside the diarization stage cache, so re-tuning merge/rescore thresholds never re-runs diarization.

## Scoring against ground truth

Hand-labeled benchmarks live in `eval/ground-truth/` — format: one segment per line, `text | Speaker`.

```powershell
# Score an episode (reads gen-large-v3/<stem>.json vs eval/ground-truth/<stem>.txt)
python score_transcript.py "2016-11-16 MSSPOT Ep. 1 - Inaugral Business"

# Ep. 142 must be scored against the verified file (working .txt has unverified prefill)
python score_transcript.py "2019-08-15 MSSPOT Ep. 142 - War Room II-Pt 1" `
  --gt-file "eval/ground-truth/2019-08-15 MSSPOT Ep. 142 - War Room II-Pt 1.verified.txt"
```

Reports word-level attribution (cluster purity, strict 1:1, host separation), segmentation boundary P/R/F1, per-cluster purity, a confusion matrix, and writes a word-level disagreements log to `eval/scores/`.

Reference scores (2026-07-10):

| Benchmark | Strict attribution | Host separation | Seg F1 |
|---|---|---|---|
| Ep. 1 (2 hosts, 838 GT lines) | 89.6% | 92.6% | 92.1% |
| Ep. 142 (4-speaker war room, 530 GT lines) | 82.6% | 82.6% | 85.0% |

Any engine change should be re-scored against both before shipping. Fast loop: `--rebuild-turns-only` reruns everything after diarization from cache in seconds.

Creating ground truth for a new episode (correction pass, not from scratch):

```powershell
# Export with the engine's guesses prefilled (~10% need fixing)
python make_ground_truth_txt.py --only "<episode stem>" --prefill --name-map "SPEAKER_04=Matt,SPEAKER_02=Shane"

# Hand-correct labels/segments, then to resume a half-finished file later:
python make_ground_truth_txt.py --only "<episode stem>" --continue-existing --name-map "..."
```

Known dead ends (measured, do not rebuild): turn-context repair (94% of errors have wrong local context too), single-word island absorption (flanked islands are ~96% REAL interjections), two-pass diarization with forced speaker count (scores identical to cluster merge at 2x cost).

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
