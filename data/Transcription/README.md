# MSSP Transcribe

Bulk-transcribe podcast audio with [WhisperX](https://github.com/m-bain/whisperX) and export **player-ready transcript JSON** for Apple Podcasts–style live transcript UIs.

## Layout

| File | Role |
|------|------|
| [`transcribe.py`](transcribe.py) | Main CLI |
| [`row_builder.py`](row_builder.py) | Display row algorithm (`speaker-turn-v1`) |
| [`pipeline_monitor.py`](pipeline_monitor.py) | Progress %, timing, GPU snapshots |
| [`requirements.txt`](requirements.txt) | Dependencies |
| [`.env.example`](.env.example) | HF token template |
| `*.json` | Generated transcripts (gitignored) |

**Defaults:** input = parent folder (episode audio), output = this folder.

## Setup

```powershell
# venv typically lives in parent podcast folder
cd ..
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu124
pip install whisperx
pip install -r transcripts\requirements.txt
```

Copy `.env.example` → `../.env` (or `.env` here) and set `HF_TOKEN` for `--diarize`.

## Usage

From the **parent** folder (where `.mp3` files live):

```powershell
python transcripts\transcribe.py --language en --model large-v3-turbo --diarize --min-speakers 1 --max-speakers 6
```

Or from this folder:

```powershell
python transcribe.py --diarize
```

Single episode:

```powershell
python transcripts\transcribe.py --only "episode.mp3" --diarize --force
```

### Key flags

| Flag | Default | Notes |
|------|---------|--------|
| `-i` / `--input` | parent folder | Audio source |
| `-o` / `--output` | this folder | Transcript JSON |
| `--row-pause-sec` | `1.5` | Gap before new display row |
| `--row-max-words` | `40` | Soft row length |
| `--row-hard-max-words` | `56` | Hard ceiling |

6GB GPU: ASR CUDA, align CPU, diarize CUDA (automatic).
