# MSSP Transcribe (portable)

Copy this **entire folder** into any directory that contains episode audio. Paths are relative to this folder — no `-i` / `-o` needed.

## Layout after copy

```
YourAudioFolder/
  2016-11-16 MSSPOT Ep. 1 - ....mp3
  ...
  Transcription/              # this folder (rename to transcripts/ if you prefer)
    transcribe.py
    transcribe.bat            # double-click or run from anywhere
    transcribe_large_v3.bat   # comparison run using Whisper large-v3
    transcribe.ps1
    row_builder.py
    pipeline_monitor.py
    .env                      # optional: HF_TOKEN for diarization
    gen/                      # created on first run
      index.json
      {episode-stem}.json
```

| Path | Role |
|------|------|
| **Parent folder** | Audio input (`.mp3`, etc.) |
| **`gen/`** | Transcript JSON output |
| This folder | Scripts only (safe to copy as a unit) |

## One-time setup

```powershell
cd ..   # audio folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu124
pip install whisperx
pip install -r Transcription\requirements.txt
```

Copy `.env.example` → `.env` here (or in the parent audio folder) and set `HF_TOKEN` for speaker diarization.

## Run

**Easiest** — from this folder:

```powershell
.\transcribe.bat
```

Or PowerShell:

```powershell
.\transcribe.ps1
```

Both run `transcribe.py --diarize` with defaults:

- Input: parent folder (audio)
- Output: `./gen/`
- Model: `large-v3-turbo`
- Speakers: 1–6

Manual equivalents:

```powershell
python transcribe.py --diarize
python transcribe.py --only "episode.mp3" --diarize --force
```

Pass extra flags through the launchers: `.\transcribe.bat --test --force`

To compare the full `large-v3` model against the default Turbo model, run:

```powershell
.\transcribe_large_v3.bat --only "episode.mp3" --force
```

This uses the same diarization and JSON pipeline as `transcribe.bat`; only the
Whisper ASR model changes. Test results go to `gen-large-v3/`, keeping the Turbo
baseline in `gen/` intact. An explicit `--output` flag can override that folder.

## Key flags

| Flag | Default | Notes |
|------|---------|--------|
| `-i` / `--input` | parent folder | Override only if audio lives elsewhere |
| `-o` / `--output` | `./gen/` | Override only for custom output path |
| `--diarize` | off in CLI; **on** in `.bat`/`.ps1` | Needs `HF_TOKEN` |
| `--row-pause-sec` | `1.5` | Display row gap |
| `--force` | off | Re-process existing JSON in `gen/` |

6GB GPU: ASR CUDA, align CPU, diarize CUDA (automatic).
