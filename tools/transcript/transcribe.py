#!/usr/bin/env python3
"""
Bulk-transcribe podcast audio with WhisperX and export player-ready MSSP transcript JSON.

Portable folder layout (copy this entire directory next to your audio files):

  YourAudioFolder/
    *.mp3
    Transcription/          # or rename to transcripts/
      transcribe.py
      transcribe.bat
      gen/                  # created on first run (default output)
        index.json
        {episode-stem}.json

Defaults: input = parent folder (audio), output = ./gen/
"""

from __future__ import annotations

import argparse
import gc
import inspect
import json
import os
import platform
import re
import sys
import subprocess
import traceback
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cache_manager import (
    CACHE_SCHEMA_VERSION,
    CACHE_SUBDIR,
    STAGE_ALIGNED,
    STAGE_ASR,
    STAGE_AUDIO,
    STAGE_DIARIZATION,
    STAGE_SPEECH_TURNS,
    STAGE_VAD,
    STAGE_WORD_SPEAKERS,
    TranscriptCache,
    hash_config,
    hash_file,
)
from diagnostics_v2 import build_episode_diagnostics, manifest_fields_from_diagnostics, write_qa_report
from pipeline_monitor import PipelineMonitor
from presets import PRESET_FORCED_TWO_HOST, preset_to_dict
from row_builder import ROW_STRATEGY_V1, ROW_STRATEGY_V2, rebuild_display_rows
from speaker_analyzer import analyze_speakers, resolve_smoothing_preset
from speaker_assignment import (
    assign_words_from_diarization,
    log_diarization_result,
    log_serialized_diarization,
    percent_unknown_words,
    serialize_diarization_segments,
)
from turn_builder import build_speech_turns
from vad import (
    build_transcribe_vad_kwargs,
    build_vad_cache_payload,
    default_vad_settings,
    derive_regions_from_segments,
    flag_vad_mismatches,
)

MODEL_FALLBACK_CHAIN = ["large-v3-turbo", "large-v3", "distil-large-v3"]
LOW_RAM_FALLBACK_CHAIN = ["medium.en", "small.en", "base.en"]
DEFAULT_EXTENSIONS = [".mp3", ".m4a", ".mp4", ".wav", ".flac", ".aac", ".ogg", ".opus"]
INVALID_WIN_CHARS = re.compile(r'[<>:"/\\|?*]')
CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
MANIFEST_NAME = "index.json"
OUTPUT_SUBDIR = "gen"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT_DIR = SCRIPT_DIR.parent
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / OUTPUT_SUBDIR
TRANSCRIPT_FORMAT = "mssp-transcript"
TRANSCRIPT_VERSION = "1.2.0"
ROW_STRATEGY_DEFAULT = ROW_STRATEGY_V2
TURN_STRATEGY_DEFAULT = "adaptive-speaker-turn-v1"
ASR_BACKEND = "whisperx-faster-whisper"
SAMPLE_RATE = 16000
HF_SETUP_MSG = (
    "HuggingFace token required for --diarize:\n"
    "  1. Create token: https://huggingface.co/settings/tokens\n"
    "  2. Accept license: https://huggingface.co/pyannote/speaker-diarization-community-1\n"
    "  3. Set HF_TOKEN in .env or environment, or pass --hf-token"
)


@dataclass
class RunConfig:
    input_dir: Path
    output_dir: Path
    cache_dir: Path
    requested_model: str
    actual_model: str | None = None
    compute_type: str = "float16"
    requested_compute_type: str = "float16"
    batch_size: int = 4
    align_batch_size: int | None = None
    language: str | None = None
    device: str = "cuda"
    align_device: str = "cuda"
    diarize_device: str = "cuda"
    recursive: bool = False
    preserve_folders: bool = False
    diarize: bool = False
    hf_token: str | None = None
    min_speakers: int = 2
    max_speakers: int = 8
    num_speakers: int | None = None
    speaker_mode: str = "adaptive"
    speaker_smoothing: str | None = None
    row_strategy: str = ROW_STRATEGY_DEFAULT
    turn_strategy: str = TURN_STRATEGY_DEFAULT
    row_min_words: int = 6
    row_max_words: int = 40
    row_hard_max_words: int = 56
    row_pause_sec: float = 1.5
    row_turn_pause_sec: float = 2.5
    show_progress: bool = True
    diarize_cpu_fallback: bool = False
    reuse_cache: bool = True
    cache_schema_version: str = CACHE_SCHEMA_VERSION
    vad_settings: dict[str, Any] | None = None
    rebuild_turns_only: bool = False
    rebuild_rows_only: bool = False
    force_asr: bool = False
    force_align: bool = False
    force_diarize: bool = False
    force_turns: bool = False
    write_diagnostics: bool = True
    fail_on_invalid: bool = False
    qa_report: bool = False
    speaker_assignment_padding_sec: float = 0.10

    def row_settings_dict(self) -> dict[str, Any]:
        return {
            "row_min_words": self.row_min_words,
            "row_max_words": self.row_max_words,
            "row_hard_max_words": self.row_hard_max_words,
            "row_pause_sec": self.row_pause_sec,
            "row_turn_pause_sec": self.row_turn_pause_sec,
        }

    def asr_config_hash(self) -> str:
        return hash_config(
            {
                "backend": ASR_BACKEND,
                "model": self.requested_model,
                "device": self.device,
                "compute_type": self.requested_compute_type,
                "batch_size": self.batch_size,
                "language": self.language,
                "vad": self.vad_settings or default_vad_settings(),
            }
        )

    def align_config_hash(self, language: str) -> str:
        return hash_config({"language": language, "device": self.align_device})

    def effective_num_speakers(self) -> int | None:
        if self.speaker_mode == "forced-two-host":
            return 2
        return self.num_speakers

    def diarize_config_hash(self) -> str:
        payload: dict[str, Any] = {
            "min_speakers": self.min_speakers,
            "max_speakers": self.max_speakers,
            "device": self.diarize_device,
            "speaker_mode": self.speaker_mode,
        }
        effective = self.effective_num_speakers()
        if effective is not None:
            payload["num_speakers"] = effective
        return hash_config(payload)

    def turns_config_hash(self, preset_name: str) -> str:
        return hash_config(
            {
                "turn_strategy": self.turn_strategy,
                "speaker_mode": self.speaker_mode,
                "speaker_smoothing": self.speaker_smoothing,
                "preset": preset_name,
                "padding_sec": self.speaker_assignment_padding_sec,
            }
        )

    def asr_metadata(self, actual_model: str, effective_batch: int) -> dict[str, Any]:
        return {
            "backend": ASR_BACKEND,
            "model": actual_model,
            "requested_model": self.requested_model,
            "device": self.device,
            "compute_type": self.compute_type,
            "requested_compute_type": self.requested_compute_type,
            "batch_size": effective_batch,
            "vad": self.vad_settings or default_vad_settings(),
        }


@dataclass
class RunStats:
    processed: int = 0
    skipped: int = 0
    failed: int = 0
    remaining: int = 0


@dataclass
class AlignCache:
    model: Any = None
    metadata: Any = None
    language: str | None = None
    device: str | None = None


@dataclass
class DiarizeCache:
    model: Any = None
    device: str | None = None


@dataclass
class ManifestItem:
    source_file: str
    filename_stem: str
    transcript_file: str
    status: str
    reason: str | None = None
    error: str | None = None
    duration_seconds: float | None = None
    word_count: int | None = None
    segment_count: int | None = None
    version: str | None = None
    diarized: bool | None = None
    speaker_count: int | None = None
    raw_segment_count: int | None = None
    quality_flags: list[str] | None = None
    single_word_segment_percent: float | None = None
    max_transcript_gap_seconds: float | None = None
    large_transcript_gap_count: int | None = None
    speech_turn_count: int | None = None
    detected_speaker_count: int | None = None
    credible_speaker_count: int | None = None
    main_speaker_count: int | None = None
    secondary_speaker_count: int | None = None
    cameo_speaker_count: int | None = None
    glitch_speaker_count: int | None = None
    speaker_changes_per_minute: float | None = None
    micro_turn_percent: float | None = None
    low_confidence_word_percent: float | None = None
    overlap_possible_word_percent: float | None = None
    diarization_stability: str | None = None
    recommended_preset: str | None = None
    turn_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        item: dict[str, Any] = {
            "sourceFile": self.source_file,
            "filenameStem": self.filename_stem,
            "transcriptFile": self.transcript_file,
            "status": self.status,
        }
        if self.reason:
            item["reason"] = self.reason
        if self.error:
            item["error"] = self.error
        if self.duration_seconds is not None:
            item["durationSeconds"] = round(self.duration_seconds, 3)
        if self.word_count is not None:
            item["wordCount"] = self.word_count
        if self.segment_count is not None:
            item["segmentCount"] = self.segment_count
        if self.version:
            item["version"] = self.version
        if self.diarized is not None:
            item["diarized"] = self.diarized
        if self.speaker_count is not None:
            item["speakerCount"] = self.speaker_count
        if self.raw_segment_count is not None:
            item["rawSegmentCount"] = self.raw_segment_count
        if self.quality_flags:
            item["qualityFlags"] = self.quality_flags
        if self.single_word_segment_percent is not None:
            item["singleWordSegmentPercent"] = self.single_word_segment_percent
        if self.max_transcript_gap_seconds is not None:
            item["maxTranscriptGapSeconds"] = round(self.max_transcript_gap_seconds, 3)
        if self.large_transcript_gap_count is not None:
            item["largeTranscriptGapCount"] = self.large_transcript_gap_count
        if self.speech_turn_count is not None:
            item["speechTurnCount"] = self.speech_turn_count
        if self.detected_speaker_count is not None:
            item["detectedSpeakerCount"] = self.detected_speaker_count
        if self.credible_speaker_count is not None:
            item["credibleSpeakerCount"] = self.credible_speaker_count
        if self.main_speaker_count is not None:
            item["mainSpeakerCount"] = self.main_speaker_count
        if self.secondary_speaker_count is not None:
            item["secondarySpeakerCount"] = self.secondary_speaker_count
        if self.cameo_speaker_count is not None:
            item["cameoSpeakerCount"] = self.cameo_speaker_count
        if self.glitch_speaker_count is not None:
            item["glitchSpeakerCount"] = self.glitch_speaker_count
        if self.speaker_changes_per_minute is not None:
            item["speakerChangesPerMinute"] = self.speaker_changes_per_minute
        if self.micro_turn_percent is not None:
            item["microTurnPercent"] = self.micro_turn_percent
        if self.low_confidence_word_percent is not None:
            item["lowConfidenceWordPercent"] = self.low_confidence_word_percent
        if self.overlap_possible_word_percent is not None:
            item["overlapPossibleWordPercent"] = self.overlap_possible_word_percent
        if self.diarization_stability is not None:
            item["diarizationStability"] = self.diarization_stability
        if self.recommended_preset is not None:
            item["recommendedPreset"] = self.recommended_preset
        if self.turn_source is not None:
            item["turnSource"] = self.turn_source
        return item


def configure_windows_hf_cache() -> None:
    if platform.system() == "Windows":
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def load_dotenv_hf_token() -> None:
    """Load HF_TOKEN from .env next to script, parent folder, or cwd."""
    if os.environ.get("HF_TOKEN"):
        return
    for env_path in (
        Path.cwd() / ".env",
        SCRIPT_DIR / ".env",
        SCRIPT_DIR.parent / ".env",
    ):
        if not env_path.is_file():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "HF_TOKEN":
                os.environ.setdefault("HF_TOKEN", value.strip().strip('"').strip("'"))
                return


def resolve_hf_token(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    load_dotenv_hf_token()
    return os.environ.get("HF_TOKEN")


def warn_if_cpu_torch_on_cuda_device(device: str) -> None:
    if device != "cuda":
        return
    import torch

    if "+cpu" in torch.__version__ or not torch.cuda.is_available():
        print(
            "WARNING: CUDA device selected but PyTorch has no GPU backend. "
            "Reinstall CUDA torch after whisperx:\n"
            "  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124",
            file=sys.stderr,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bulk-transcribe podcast audio with WhisperX and export player-ready JSON."
    )
    parser.add_argument("-i", "--input", type=Path, default=DEFAULT_INPUT_DIR, help="Audio folder (default: parent of this script)")
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT_DIR, help="Transcript JSON folder (default: ./gen/)")
    parser.add_argument("--recursive", action="store_true", help="Scan subdirectories for audio")
    parser.add_argument("--preserve-folders", action="store_true", help="Mirror input subfolder structure under output")
    parser.add_argument("--test", action="store_true", help="Process only the first eligible file")
    parser.add_argument("--only", default=None, help="Process only this exact filename")
    parser.add_argument("--force", action="store_true", help="Re-transcribe even if output JSON exists")
    parser.add_argument("--language", default=None, help="Force language code (e.g. en)")
    parser.add_argument("--model", default="large-v3-turbo", help="Target ASR model name")
    parser.add_argument(
        "--compute-type",
        "--asr-compute-type",
        dest="compute_type",
        default=None,
        help="CTranslate2 compute type (default: float16 on CUDA, int8 on CPU)",
    )
    parser.add_argument("--batch-size", "--asr-batch-size", dest="batch_size", type=int, default=4, help="ASR inference batch size")
    parser.add_argument("--align-batch-size", type=int, default=None, help="Reserved for future use")
    parser.add_argument("--device", "--asr-device", dest="device", default=None, help="ASR device: cuda or cpu (auto-detect if omitted)")
    parser.add_argument(
        "--align-device",
        default=None,
        choices=["cuda", "cpu"],
        help="Alignment device (default: cpu on GPUs with <8GB VRAM)",
    )
    parser.add_argument(
        "--diarize-device",
        default=None,
        choices=["cuda", "cpu"],
        help="Diarization device (default: cuda when GPU available; align moves to CPU on <8GB VRAM)",
    )
    parser.add_argument("--diarize", action="store_true", help="Enable speaker diarization (requires HF token)")
    parser.add_argument("--hf-token", default=None, help="HuggingFace token (or set HF_TOKEN / .env)")
    parser.add_argument("--min-speakers", type=int, default=2, help="Min speakers for diarization")
    parser.add_argument("--max-speakers", type=int, default=8, help="Max speakers for diarization")
    parser.add_argument("--num-speakers", type=int, default=None, help="Fixed speaker count (forced-two-host rerun only)")
    parser.add_argument(
        "--speaker-mode",
        default="adaptive",
        choices=["adaptive", "normal", "group", "chaotic", "forced-two-host"],
        help="Speaker analysis/smoothing mode",
    )
    parser.add_argument(
        "--speaker-smoothing",
        default=None,
        choices=["normal", "aggressive", "conservative"],
        help="Override smoothing intensity",
    )
    parser.add_argument("--turn-strategy", default=TURN_STRATEGY_DEFAULT, help="Canonical turn build strategy")
    parser.add_argument("--row-strategy", default=ROW_STRATEGY_DEFAULT, help="Display row rebuild strategy")
    parser.add_argument("--row-min-words", type=int, default=6, help="Min words before sentence can split a row")
    parser.add_argument("--row-max-words", type=int, default=40, help="Soft target max words per display row")
    parser.add_argument(
        "--row-hard-max-words",
        type=int,
        default=56,
        help="Hard ceiling for row length; splits at best boundary when reached",
    )
    parser.add_argument("--row-pause-sec", type=float, default=1.5, help="Gap (seconds) before new display row")
    parser.add_argument("--row-turn-pause-sec", type=float, default=2.5, help="Gap (seconds) before new turnId")
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable per-stage progress %% and timing logs",
    )
    parser.add_argument(
        "--diarize-cpu-fallback",
        action="store_true",
        help="On CUDA diarization OOM, retry on CPU (can take hours per episode)",
    )
    parser.add_argument(
        "--extensions",
        default=",".join(DEFAULT_EXTENSIONS),
        help="Comma-separated audio extensions to scan",
    )
    parser.add_argument("--limit", type=int, default=None, help="Process at most N files")
    parser.add_argument("--start-after", default=None, help="Skip until after this exact filename")
    parser.add_argument("--cache-version", default=CACHE_SCHEMA_VERSION, help="Required cache schema version")
    parser.add_argument("--reuse-cache", dest="reuse_cache", action="store_true", help="Reuse cached stage outputs (default)")
    parser.add_argument("--no-cache", dest="reuse_cache", action="store_false", help="Disable stage cache reads")
    parser.add_argument("--force-asr", action="store_true", help="Force ASR stage rerun")
    parser.add_argument("--force-align", action="store_true", help="Force alignment stage rerun")
    parser.add_argument("--force-diarize", action="store_true", help="Force diarization stage rerun")
    parser.add_argument("--force-turns", action="store_true", help="Force turn-building stage rerun")
    parser.add_argument("--rebuild-turns-only", action="store_true", help="Rebuild turns/rows from cached diarization")
    parser.add_argument("--rebuild-rows-only", action="store_true", help="Rebuild display rows from cached speech turns")
    parser.add_argument("--write-diagnostics", dest="write_diagnostics", action="store_true", help="Write diagnostics (default)")
    parser.add_argument("--no-write-diagnostics", dest="write_diagnostics", action="store_false")
    parser.add_argument("--fail-on-invalid", action="store_true", help="Fail save when validation fails")
    parser.add_argument("--qa-report", action="store_true", help="Write QA summary from manifest after run")
    parser.add_argument(
        "--isolate-per-file",
        action="store_true",
        help="Run each queued file in a fresh Python process; safer for large-v3 CUDA batches on 6GB GPUs",
    )
    parser.set_defaults(reuse_cache=True, write_diagnostics=True)
    align_group = parser.add_mutually_exclusive_group()
    align_group.add_argument(
        "--reuse-align-model",
        dest="reuse_align_model",
        action="store_true",
        help="Reuse alignment model across files (default)",
    )
    align_group.add_argument(
        "--no-reuse-align-model",
        dest="reuse_align_model",
        action="store_false",
        help="Free/reload alignment model per file (VRAM safety)",
    )
    diarize_reuse_group = parser.add_mutually_exclusive_group()
    diarize_reuse_group.add_argument(
        "--reuse-diarize-model",
        dest="reuse_diarize_model",
        action="store_true",
        help="Reuse diarization model across files",
    )
    diarize_reuse_group.add_argument(
        "--no-reuse-diarize-model",
        dest="reuse_diarize_model",
        action="store_false",
        help="Free/reload diarization model per file; safer on 6GB GPUs",
    )
    parser.set_defaults(reuse_align_model=True, reuse_diarize_model=None)
    return parser.parse_args()


def resolve_device(requested: str | None) -> str:
    import torch

    if requested:
        if requested == "cuda" and not torch.cuda.is_available():
            print("ERROR: --device cuda requested but CUDA is not available.", file=sys.stderr)
            sys.exit(1)
        return requested
    return "cuda" if torch.cuda.is_available() else "cpu"


def _gpu_vram_under_8gb() -> bool:
    import torch

    if not torch.cuda.is_available():
        return True
    return torch.cuda.get_device_properties(0).total_memory < 8 * 1024**3


def resolve_align_device(requested: str | None, asr_device: str) -> str:
    if requested:
        return requested
    if asr_device != "cuda":
        return asr_device
    if _gpu_vram_under_8gb():
        import torch

        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(
            f"NOTE: GPU VRAM is {vram_gb:.1f}GB — using CPU for alignment to avoid OOM. "
            "Pass --align-device cuda to force GPU alignment."
        )
        return "cpu"
    return "cuda"


def resolve_diarize_device(requested: str | None, asr_device: str, align_device: str) -> str:
    if requested:
        return requested
    if asr_device != "cuda":
        import torch

        if not torch.cuda.is_available():
            print(
                "NOTE: CUDA unavailable (CPU-only PyTorch or no GPU) — ASR, align, and diarization all run on CPU. "
                "Re-run setup.bat with Python 3.12 to get GPU diarization on 6GB cards."
            )
        return "cpu"
    if _gpu_vram_under_8gb():
        import torch

        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        if align_device == "cpu":
            print(
                f"NOTE: GPU VRAM is {vram_gb:.1f}GB — using CUDA for diarization "
                "(alignment on CPU leaves VRAM for pyannote). "
                "Pass --diarize-device cpu only if you accept multi-hour runs."
            )
        else:
            print(
                f"NOTE: GPU VRAM is {vram_gb:.1f}GB — diarization on CUDA with align also on CUDA "
                "may OOM on long episodes. Prefer default --align-device cpu, or the pipeline "
                "will unload the align model from GPU before diarization."
            )
        return "cuda"
    return "cuda"


def release_align_cache_from_gpu(align_cache: AlignCache) -> None:
    """Free alignment weights from GPU so diarization can use VRAM."""
    if align_cache.model is None:
        return
    free_gpu(align_cache.model)
    align_cache.model = None


def is_host_ram_oom(exc: BaseException) -> bool:
    message = str(exc).lower()
    if "mkl_malloc" in message:
        return True
    if "failed to allocate memory" in message and "cuda" not in message:
        return True
    cause = exc.__cause__
    return is_host_ram_oom(cause) if cause is not None else False


def is_cuda_oom(exc: BaseException) -> bool:
    if is_host_ram_oom(exc):
        return False
    message = str(exc).lower()
    if "cuda" not in message:
        return False
    return "out of memory" in message or "cuda failed" in message


def is_cuda_asr_recoverable(exc: BaseException) -> bool:
    """CUDA failures where a different compute type or CPU may succeed."""
    if is_host_ram_oom(exc):
        return False
    if is_cuda_oom(exc):
        return True
    message = str(exc).lower()
    if "cublas" in message:
        return True
    return "cuda" in message and ("failed" in message or "error" in message)


def asr_attempt_plan(device: str, compute_type: str) -> list[tuple[str, str]]:
    """Ordered (device, compute_type) fallbacks for ASR."""
    plan: list[tuple[str, str]] = [(device, compute_type)]
    if device == "cuda":
        if compute_type not in {"float16", "int8_float16"}:
            plan.append((device, "float16"))
        if compute_type != "int8_float16":
            plan.append((device, "int8_float16"))
        if compute_type != "int8":
            plan.append((device, "int8"))
        plan.append(("cpu", "int8"))
    return plan


def log_gpu_memory(label: str) -> None:
    import torch

    if not torch.cuda.is_available():
        return
    free_b, total_b = torch.cuda.mem_get_info()
    alloc_b = torch.cuda.memory_allocated()
    reserved_b = torch.cuda.memory_reserved()
    print(
        f"  GPU memory ({label}): "
        f"{alloc_b / 1024**3:.2f}GB allocated, "
        f"{reserved_b / 1024**3:.2f}GB reserved, "
        f"{free_b / 1024**3:.2f}GB free / {total_b / 1024**3:.1f}GB total"
    )


def parse_extensions(raw: str) -> set[str]:
    extensions: set[str] = set()
    for part in raw.split(","):
        part = part.strip().lower()
        if not part:
            continue
        if not part.startswith("."):
            part = f".{part}"
        extensions.add(part)
    return extensions or set(DEFAULT_EXTENSIONS)


def discover_audio_files(input_dir: Path, extensions: set[str], recursive: bool) -> list[Path]:
    input_dir = input_dir.resolve()
    if not input_dir.is_dir():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    files: list[Path] = []
    iterator = input_dir.rglob("*") if recursive else input_dir.glob("*")
    for path in iterator:
        if path.is_file() and path.suffix.lower() in extensions:
            files.append(path.resolve())
    return sorted(files, key=lambda p: str(p).lower())


def apply_file_filters(
    files: list[Path],
    start_after: str | None,
    limit: int | None,
    test: bool,
    only: str | None,
) -> list[Path]:
    if only:
        files = [f for f in files if f.name == only]
        if not files:
            print(f"WARNING: --only file not found: {only}", file=sys.stderr)
        return files

    if start_after:
        idx = None
        for i, path in enumerate(files):
            if path.name == start_after:
                idx = i
                break
        if idx is None:
            print(f"WARNING: --start-after file not found: {start_after}", file=sys.stderr)
        else:
            files = files[idx + 1 :]

    if limit is not None:
        files = files[:limit]

    if test and files:
        files = files[:1]

    return files


def filename_stem(source_path: Path) -> str:
    return source_path.stem


def safe_filename_component(name: str) -> str:
    return INVALID_WIN_CHARS.sub("_", name)


def source_relative_path(source_path: Path, input_dir: Path) -> str:
    try:
        return source_path.resolve().relative_to(input_dir.resolve()).as_posix()
    except ValueError:
        return source_path.name


def transcript_output_path(
    source_path: Path,
    input_dir: Path,
    output_dir: Path,
    preserve_folders: bool,
) -> Path:
    stem = safe_filename_component(source_path.stem)
    if preserve_folders:
        rel = source_path.resolve().relative_to(input_dir.resolve())
        parent = rel.parent
        return output_dir / parent / f"{stem}.json"
    return output_dir / f"{stem}.json"


def transcript_file_manifest_path(output_path: Path, output_dir: Path) -> str:
    try:
        return output_path.resolve().relative_to(output_dir.resolve()).as_posix()
    except ValueError:
        return output_path.name


def free_gpu(*objects: Any) -> None:
    import torch

    for obj in objects:
        try:
            del obj
        except Exception:
            pass
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()


def clear_model_caches(
    align_cache: AlignCache | None = None,
    diarize_cache: DiarizeCache | None = None,
) -> None:
    """Actually release cached model references between files/stages."""
    objects: list[Any] = []

    if align_cache is not None:
        if align_cache.model is not None:
            objects.append(align_cache.model)
        align_cache.model = None
        align_cache.metadata = None
        align_cache.language = None
        align_cache.device = None

    if diarize_cache is not None:
        if diarize_cache.model is not None:
            objects.append(diarize_cache.model)
        diarize_cache.model = None
        diarize_cache.device = None

    free_gpu(*objects)


def round_time(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 3)


class TranscriptValidationError(ValueError):
    """Raised when a transcript document fails structural or JSON validation."""


def sanitize_text(text: str) -> str:
    """Strip raw control characters that can break JSON consumers."""
    return CONTROL_CHAR_RE.sub("", text)


def sanitize_json_value(value: Any) -> Any:
    if is_dataclass(value):
        return sanitize_json_value(asdict(value))
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): sanitize_json_value(item) for key, item in value.items()}
    return value


def sanitize_transcript_document(document: dict[str, Any]) -> dict[str, Any]:
    return sanitize_json_value(document)


def resolve_compute_type(requested: str | None, device: str) -> str:
    if requested:
        return requested
    return "float16" if device == "cuda" else "int8"


def validate_transcript_document(document: dict[str, Any]) -> None:
    """Structural checks after json.load round-trip."""
    required_top = ("version", "format", "metadata", "segments", "wordSegments", "rawSegments", "diagnostics")
    for key in required_top:
        if key not in document:
            raise TranscriptValidationError(f"Missing required field: {key}")

    if document.get("format") != TRANSCRIPT_FORMAT:
        raise TranscriptValidationError(f"Unexpected format: {document.get('format')!r}")

    version = str(document.get("version", "1.1.0"))
    if version >= "1.2.0":
        for key in ("diarizationSegments", "speechTurns"):
            if key not in document:
                raise TranscriptValidationError(f"Missing required v1.2 field: {key}")
            if not isinstance(document[key], list):
                raise TranscriptValidationError(f"{key} must be an array")

    metadata = document["metadata"]
    if not isinstance(metadata, dict):
        raise TranscriptValidationError("metadata must be an object")

    for field_name in ("segments", "wordSegments", "rawSegments"):
        value = document[field_name]
        if not isinstance(value, list):
            raise TranscriptValidationError(f"{field_name} must be an array")

    diagnostics = document["diagnostics"]
    if not isinstance(diagnostics, dict):
        raise TranscriptValidationError("diagnostics must be an object")

    word_count = diagnostics.get("wordCount")
    if word_count is not None and word_count != len(document["wordSegments"]):
        raise TranscriptValidationError(
            f"diagnostics.wordCount ({word_count}) != len(wordSegments) ({len(document['wordSegments'])})"
        )

    segment_count = diagnostics.get("segmentCount")
    if segment_count is not None and segment_count != len(document["segments"]):
        raise TranscriptValidationError(
            f"diagnostics.segmentCount ({segment_count}) != len(segments) ({len(document['segments'])})"
        )

    if version >= "1.2.0":
        turn_count = diagnostics.get("speechTurnCount")
        if turn_count is not None and turn_count != len(document["speechTurns"]):
            raise TranscriptValidationError(
                f"diagnostics.speechTurnCount ({turn_count}) != len(speechTurns) ({len(document['speechTurns'])})"
            )
        if diagnostics.get("rowWordIntegrityOk") is False:
            raise TranscriptValidationError("rowWordIntegrityOk is false")
        single_word_pct = diagnostics.get("singleWordSegmentPercent")
        if single_word_pct is not None and single_word_pct > 30:
            raise TranscriptValidationError(
                f"singleWordSegmentPercent ({single_word_pct}) exceeds 30% row fragmentation limit"
            )


def validate_json_file(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data


def atomic_write_json(
    path: Path,
    data: dict[str, Any],
    *,
    post_load_validate: Any | None = None,
) -> None:
    """Write JSON atomically: .tmp → parse-validate → os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")

    json.dumps(data, ensure_ascii=False)

    try:
        with tmp_path.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())

        loaded = validate_json_file(tmp_path)
        if post_load_validate is not None:
            post_load_validate(loaded)

        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def save_transcript_json(path: Path, document: dict[str, Any]) -> None:
    """Sanitize, write, round-trip json.load, structure-validate, then commit."""
    clean = sanitize_transcript_document(document)
    atomic_write_json(path, clean, post_load_validate=validate_transcript_document)


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.exists():
        return {"items": []}
    with manifest_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def update_manifest_atomic(output_dir: Path, item: ManifestItem, run_config: RunConfig) -> None:
    manifest_path = output_dir / MANIFEST_NAME
    manifest = load_manifest(manifest_path)
    items: list[dict[str, Any]] = manifest.get("items", [])
    item_dict = item.to_dict()
    replaced = False
    for i, existing in enumerate(items):
        if existing.get("sourceFile") == item.source_file:
            items[i] = item_dict
            replaced = True
            break
    if not replaced:
        items.append(item_dict)

    manifest["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest["model"] = run_config.actual_model or run_config.requested_model
    manifest["computeType"] = run_config.compute_type
    manifest["inputDir"] = str(run_config.input_dir)
    manifest["items"] = items
    atomic_write_json(manifest_path, manifest)


def resolve_batch_size(batch_size: int, device: str, diarize: bool) -> int:
    """Cap batch size on low-VRAM GPUs; diarize runs keep extra headroom for ASR."""
    if device != "cuda" or not _gpu_vram_under_8gb():
        return batch_size
    cap = 1 if diarize else min(batch_size, 4)
    effective = min(batch_size, cap)
    if effective < batch_size:
        import torch

        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(
            f"NOTE: GPU VRAM is {vram_gb:.1f}GB — using batch_size={effective} "
            f"(requested {batch_size})" + (" for --diarize run" if diarize else "")
        )
    return effective


def resolve_and_load_asr_model(
    requested: str,
    device: str,
    compute_type: str,
) -> tuple[Any, str]:
    import whisperx

    def dedupe(names: list[str]) -> list[str]:
        out: list[str] = []
        for name in names:
            if name not in out:
                out.append(name)
        return out

    chains: list[list[str]] = [dedupe([requested, *MODEL_FALLBACK_CHAIN])]
    last_error: Exception | None = None
    saw_host_oom = False

    for chain_idx, candidates in enumerate(chains):
        if chain_idx > 0:
            print("  NOTE: Retrying with smaller ASR models due to low system RAM")
        for model_name in candidates:
            try:
                free_gpu()
                print(f"  Loading ASR model: {model_name} (device={device}, compute_type={compute_type})")
                model = whisperx.load_model(
                    model_name,
                    device,
                    compute_type=compute_type,
                )
                if model_name != requested:
                    print(f"  NOTE: Requested model '{requested}' unavailable; using '{model_name}'")
                else:
                    print(f"  Using ASR model: {model_name}")
                return model, model_name
            except Exception as exc:
                last_error = exc
                print(f"  WARNING: Failed to load model '{model_name}': {exc}")
                if is_host_ram_oom(exc):
                    saw_host_oom = True
                    break

        if saw_host_oom and chain_idx == 0:
            chains.append(dedupe(LOW_RAM_FALLBACK_CHAIN))

    raise RuntimeError(
        "Could not load any ASR model. "
        + (
            "Close other apps to free system RAM and retry, or pass --model medium.en / small.en."
            if saw_host_oom
            else f"Tried: {chains[0]}"
        )
    ) from last_error


def clean_word_from_whisper(word_data: dict[str, Any]) -> dict[str, Any] | None:
    body = sanitize_text(str(word_data.get("word", word_data.get("body", ""))).strip())
    if not body:
        return None

    cleaned: dict[str, Any] = {"body": body}
    start = round_time(word_data.get("start", word_data.get("startTime")))
    end = round_time(word_data.get("end", word_data.get("endTime")))
    if start is not None:
        cleaned["startTime"] = start
    if end is not None:
        cleaned["endTime"] = end
    speaker = word_data.get("speaker")
    if speaker:
        cleaned["speaker"] = str(speaker)
    return cleaned


def extract_raw_segments(
    aligned_result: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Return (rawSegments, flat_words, missing_word_timestamps)."""
    raw_segments: list[dict[str, Any]] = []
    flat_words: list[dict[str, Any]] = []
    missing_word_timestamps = 0

    for segment in aligned_result.get("segments", []):
        words_out: list[dict[str, Any]] = []
        for word_data in segment.get("words", []):
            cleaned = clean_word_from_whisper(word_data)
            if cleaned is None:
                continue
            if "startTime" not in cleaned or "endTime" not in cleaned:
                missing_word_timestamps += 1
            words_out.append(
                {k: v for k, v in cleaned.items() if k in ("body", "startTime", "endTime")}
            )
            flat_words.append(cleaned)

        if not words_out:
            continue

        segment_text = str(segment.get("text", "")).strip()
        body = segment_text if segment_text else " ".join(w["body"] for w in words_out)

        seg_start = round_time(segment.get("start"))
        seg_end = round_time(segment.get("end"))
        if seg_start is None and words_out[0].get("startTime") is not None:
            seg_start = words_out[0]["startTime"]
        if seg_end is None and words_out[-1].get("endTime") is not None:
            seg_end = words_out[-1]["endTime"]

        raw_segments.append(
            {
                "startTime": seg_start,
                "endTime": seg_end,
                "body": body,
                "words": words_out,
            }
        )

    return raw_segments, flat_words, missing_word_timestamps


def build_transcript_document(
    raw_segments: list[dict[str, Any]],
    display_segments: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
    speech_turns: list[dict[str, Any]],
    diarization_segments: list[dict[str, Any]],
    source_path: Path,
    input_dir: Path,
    language: str,
    run_config: RunConfig,
    actual_model: str,
    duration_seconds: float,
    diarized: bool,
    diagnostics: dict[str, Any],
    asr_metadata: dict[str, Any] | None = None,
    speaker_preset: str | None = None,
    turn_source: str = "full_pipeline",
) -> dict[str, Any]:
    stem = filename_stem(source_path)
    metadata: dict[str, Any] = {
        "source_file": source_path.name,
        "source_path": source_relative_path(source_path, input_dir),
        "filenameStem": stem,
        "language": language,
        "requested_model": run_config.requested_model,
        "model": actual_model,
        "compute_type": run_config.compute_type,
        "aligned": True,
        "diarized": diarized,
        "row_strategy": run_config.row_strategy,
        "turn_strategy": run_config.turn_strategy,
        "speaker_mode": run_config.speaker_mode,
    }
    if asr_metadata is not None:
        metadata["asr"] = asr_metadata
    if speaker_preset:
        metadata["speaker_preset"] = speaker_preset
    if turn_source:
        metadata["turn_source"] = turn_source

    return {
        "version": TRANSCRIPT_VERSION,
        "format": TRANSCRIPT_FORMAT,
        "metadata": metadata,
        "rawSegments": raw_segments,
        "diarizationSegments": diarization_segments,
        "wordSegments": word_segments,
        "speechTurns": speech_turns,
        "segments": display_segments,
        "diagnostics": diagnostics,
    }


def filter_supported_kwargs(fn: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    """Drop kwargs unsupported by the installed WhisperX transcribe method."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return kwargs

    params = sig.parameters
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return kwargs

    return {k: v for k, v in kwargs.items() if k in params}


def _run_asr_transcribe(
    audio: Any,
    device: str,
    requested_model: str,
    compute_type: str,
    language: str | None,
    batch_size: int,
    progress_callback: Any | None = None,
    vad_settings: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    batch_sizes: list[int] = []
    bs = batch_size
    while True:
        if bs not in batch_sizes:
            batch_sizes.append(bs)
        if bs <= 1:
            break
        bs = max(1, bs // 2)

    free_gpu()
    if device == "cuda":
        log_gpu_memory("before ASR load")
    model, actual_model = resolve_and_load_asr_model(requested_model, device, compute_type)
    if device == "cuda":
        log_gpu_memory("after ASR load")

    last_error: BaseException | None = None
    try:
        for try_bs in batch_sizes:
            transcribe_kwargs: dict[str, Any] = {"batch_size": try_bs}
            transcribe_kwargs.update(build_transcribe_vad_kwargs(vad_settings))
            if language:
                transcribe_kwargs["language"] = language
            if progress_callback is not None:
                transcribe_kwargs["progress_callback"] = progress_callback
            transcribe_kwargs = filter_supported_kwargs(model.transcribe, transcribe_kwargs)
            try:
                if try_bs < batch_size:
                    print(f"  Retrying transcription with batch_size={try_bs}")
                result = model.transcribe(audio, **transcribe_kwargs)
                return result, actual_model
            except Exception as exc:
                last_error = exc
                if device == "cuda" and is_cuda_asr_recoverable(exc) and try_bs > batch_sizes[-1]:
                    print(
                        f"  WARNING: CUDA error at batch_size={try_bs} — "
                        "retrying with smaller batch (same model)"
                    )
                    free_gpu()
                    continue
                raise
    finally:
        free_gpu(model)

    assert last_error is not None
    raise last_error


def transcribe_audio(
    audio_path: Path,
    device: str,
    requested_model: str,
    compute_type: str,
    language: str | None,
    batch_size: int,
    monitor: PipelineMonitor | None = None,
    vad_settings: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], Any, str, float, str]:
    import whisperx

    audio = whisperx.load_audio(str(audio_path))
    duration_seconds = len(audio) / SAMPLE_RATE

    attempts = asr_attempt_plan(device, compute_type)
    last_error: BaseException | None = None
    progress_callback = monitor.callback_for_current_stage() if monitor else None
    for attempt_idx, (attempt_device, attempt_compute) in enumerate(attempts):
        if attempt_idx > 0:
            prev_device, prev_compute = attempts[attempt_idx - 1]
            print(
                f"  WARNING: ASR failed on {prev_device} ({prev_compute}) — "
                f"retrying on {attempt_device} ({attempt_compute})"
            )
            free_gpu()
        try:
            result, actual_model = _run_asr_transcribe(
                audio,
                attempt_device,
                requested_model,
                attempt_compute,
                language,
                batch_size,
                progress_callback,
                vad_settings=vad_settings,
            )
            if attempt_idx > 0:
                print(
                    f"  NOTE: ASR completed on {attempt_device} ({attempt_compute}) "
                    "after earlier failure"
                )
            return result, audio, actual_model, duration_seconds, attempt_compute
        except Exception as exc:
            last_error = exc
            if (
                attempt_device == "cuda"
                and is_cuda_asr_recoverable(exc)
                and attempt_idx < len(attempts) - 1
            ):
                continue
            raise

    raise RuntimeError("Transcription failed on all attempted ASR configurations") from last_error


def _load_align_model(
    language: str,
    align_device: str,
    align_cache: AlignCache,
    reuse_align_model: bool,
) -> tuple[Any, Any, AlignCache]:
    import whisperx

    if (
        reuse_align_model
        and align_cache.model is not None
        and align_cache.language == language
        and align_cache.device == align_device
    ):
        return align_cache.model, align_cache.metadata, align_cache

    if align_cache.model is not None:
        free_gpu(align_cache.model)
        align_cache.model = None
        align_cache.metadata = None
        align_cache.language = None
        align_cache.device = None

    print(f"  Loading alignment model on {align_device}")
    model_a, metadata = whisperx.load_align_model(language_code=language, device=align_device)
    if reuse_align_model:
        align_cache.model = model_a
        align_cache.metadata = metadata
        align_cache.language = language
        align_cache.device = align_device
    return model_a, metadata, align_cache


def align_words(
    segments: list[dict[str, Any]],
    audio: Any,
    language: str,
    align_device: str,
    align_cache: AlignCache,
    reuse_align_model: bool,
    monitor: PipelineMonitor | None = None,
) -> tuple[dict[str, Any], AlignCache]:
    import whisperx

    free_gpu()
    devices_to_try = [align_device]
    if align_device == "cuda":
        devices_to_try.append("cpu")

    last_error: BaseException | None = None
    progress_callback = monitor.callback_for_current_stage() if monitor else None
    for attempt_device in devices_to_try:
        if attempt_device != align_device:
            print("  WARNING: CUDA OOM during alignment — retrying on CPU")
            free_gpu(align_cache.model)
            align_cache.model = None
            align_cache.metadata = None
            align_cache.language = None
            align_cache.device = None
            reuse_align_model = False

        try:
            model_a, metadata, align_cache = _load_align_model(
                language, attempt_device, align_cache, reuse_align_model
            )
            aligned = whisperx.align(
                segments,
                model_a,
                metadata,
                audio,
                attempt_device,
                return_char_alignments=False,
                progress_callback=progress_callback,
            )
            if not reuse_align_model:
                free_gpu(model_a)
            return aligned, align_cache
        except Exception as exc:
            last_error = exc
            if attempt_device == "cuda" and is_cuda_oom(exc):
                continue
            raise

    raise RuntimeError("Alignment failed on all attempted devices") from last_error


def _load_diarize_model(
    hf_token: str,
    diarize_device: str,
    diarize_cache: DiarizeCache,
    reuse: bool,
) -> tuple[Any, DiarizeCache]:
    from whisperx.diarize import DiarizationPipeline

    if reuse and diarize_cache.model is not None and diarize_cache.device == diarize_device:
        return diarize_cache.model, diarize_cache

    if diarize_cache.model is not None:
        free_gpu(diarize_cache.model)
        diarize_cache.model = None
        diarize_cache.device = None

    print(f"  Loading diarization model on {diarize_device}")
    model = DiarizationPipeline(token=hf_token, device=diarize_device)
    if reuse:
        diarize_cache.model = model
        diarize_cache.device = diarize_device
    return model, diarize_cache


def run_diarization(
    audio: Any,
    hf_token: str,
    diarize_device: str,
    min_speakers: int,
    max_speakers: int,
    diarize_cache: DiarizeCache,
    reuse_diarize_model: bool,
    monitor: PipelineMonitor | None = None,
    cpu_fallback: bool = False,
    num_speakers: int | None = None,
) -> tuple[list[dict[str, Any]], DiarizeCache]:
    """Run pyannote on full audio; return serialized diarizationSegments."""
    free_gpu()
    devices_to_try = [diarize_device]
    if diarize_device == "cuda" and cpu_fallback:
        devices_to_try.append("cpu")

    last_error: BaseException | None = None
    progress_callback = monitor.callback_for_current_stage() if monitor else None
    for attempt_device in devices_to_try:
        if attempt_device != diarize_device:
            print(
                "  WARNING: CUDA OOM during diarization — retrying on CPU "
                "(this can take hours; omit --diarize-cpu-fallback to fail fast)",
                file=sys.stderr,
            )
            free_gpu(diarize_cache.model)
            diarize_cache.model = None
            diarize_cache.device = None
            reuse_diarize_model = False

        try:
            model, diarize_cache = _load_diarize_model(
                hf_token, attempt_device, diarize_cache, reuse_diarize_model
            )
            diarize_kwargs: dict[str, Any] = {
                "min_speakers": min_speakers,
                "max_speakers": max_speakers,
                "progress_callback": progress_callback,
            }
            if num_speakers is not None:
                diarize_kwargs["num_speakers"] = num_speakers
            raw_segments = model(audio, **diarize_kwargs)
            log_diarization_result(raw_segments)
            timeline = serialize_diarization_segments(raw_segments)
            log_serialized_diarization(timeline)
            if not timeline:
                raise RuntimeError(
                    f"Diarization returned {type(raw_segments)!r} but serialized to zero segments."
                )
            if not reuse_diarize_model:
                free_gpu(model)
            return timeline, diarize_cache
        except Exception as exc:
            last_error = exc
            if attempt_device == "cuda" and is_cuda_oom(exc):
                continue
            raise

    raise RuntimeError(
        "Diarization failed on all attempted devices. "
        + (
            "CUDA OOM: use default --align-device cpu (keep --diarize-device cuda), "
            "close other GPU apps, and avoid --align-device cuda on 6GB GPUs. "
            "Pass --diarize-cpu-fallback only if you accept multi-hour CPU diarization."
            if diarize_device == "cuda" and not cpu_fallback
            else "See error above."
        )
    ) from last_error


def require_diarization_segments(
    diarization_segments: list[dict[str, Any]],
    *,
    turn_source: str,
) -> None:
    if turn_source == "legacy_word_speakers":
        return
    if not diarization_segments:
        raise RuntimeError(
            "Diarization produced zero diarizationSegments; refusing to save full_pipeline transcript."
        )


def require_speaker_assignment(
    word_segments: list[dict[str, Any]],
    *,
    turn_source: str,
    threshold_percent: float = 50.0,
) -> None:
    if turn_source == "legacy_word_speakers":
        return
    unknown_percent = percent_unknown_words(word_segments)
    if unknown_percent > threshold_percent:
        raise RuntimeError(
            f"Speaker assignment failed: {unknown_percent:.1f}% UNKNOWN words."
        )


def manifest_item_from_diag(
    *,
    source_file: str,
    filename_stem: str,
    transcript_file: str,
    status: str,
    run_config: RunConfig,
    diag: dict[str, Any],
    reason: str | None = None,
    error: str | None = None,
) -> ManifestItem:
    manifest_extra = manifest_fields_from_diagnostics(diag)
    return ManifestItem(
        source_file=source_file,
        filename_stem=filename_stem,
        transcript_file=transcript_file,
        status=status,
        reason=reason,
        error=error,
        duration_seconds=diag.get("durationSeconds"),
        word_count=diag.get("wordCount"),
        segment_count=diag.get("segmentCount"),
        version=TRANSCRIPT_VERSION,
        diarized=run_config.diarize,
        speaker_count=diag.get("detectedSpeakerCount") or diag.get("speakerCount"),
        raw_segment_count=diag.get("rawSegmentCount"),
        quality_flags=diag.get("qualityFlags") or None,
        single_word_segment_percent=diag.get("singleWordSegmentPercent"),
        max_transcript_gap_seconds=diag.get("maxTranscriptGapSeconds"),
        large_transcript_gap_count=diag.get("largeTranscriptGapCount"),
        speech_turn_count=manifest_extra.get("speechTurnCount"),
        detected_speaker_count=manifest_extra.get("detectedSpeakerCount"),
        credible_speaker_count=manifest_extra.get("credibleSpeakerCount"),
        main_speaker_count=manifest_extra.get("mainSpeakerCount"),
        secondary_speaker_count=manifest_extra.get("secondarySpeakerCount"),
        cameo_speaker_count=manifest_extra.get("cameoSpeakerCount"),
        glitch_speaker_count=manifest_extra.get("glitchSpeakerCount"),
        speaker_changes_per_minute=manifest_extra.get("speakerChangesPerMinute"),
        micro_turn_percent=manifest_extra.get("microTurnPercent"),
        low_confidence_word_percent=manifest_extra.get("lowConfidenceWordPercent"),
        overlap_possible_word_percent=manifest_extra.get("overlapPossibleWordPercent"),
        diarization_stability=manifest_extra.get("diarizationStability"),
        recommended_preset=manifest_extra.get("recommendedPreset"),
        turn_source=manifest_extra.get("turnSource"),
    )


def finalize_from_stages(
    *,
    source_path: Path,
    input_dir: Path,
    output_path: Path,
    run_config: RunConfig,
    cache: TranscriptCache,
    episode_key: str,
    audio_hash: str,
    raw_segments: list[dict[str, Any]],
    aligned_flat_words: list[dict[str, Any]],
    diarization_segments: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
    speech_turns: list[dict[str, Any]],
    display_segments: list[dict[str, Any]],
    duration_seconds: float,
    language: str,
    actual_model: str,
    asr_metadata: dict[str, Any],
    speaker_analysis: dict[str, Any] | None,
    turn_counters: dict[str, int],
    vad_mismatch_count: int,
    missing_word_timestamps: int,
    turn_source: str,
    speaker_preset: str,
    pipeline_timing: dict[str, Any] | None,
    monitor: PipelineMonitor,
) -> dict[str, Any]:
    diagnostics = build_episode_diagnostics(
        raw_segments=raw_segments,
        diarization_segments=diarization_segments,
        word_segments=word_segments,
        speech_turns=speech_turns,
        display_segments=display_segments,
        duration_seconds=duration_seconds,
        diarized=run_config.diarize,
        speaker_analysis=speaker_analysis,
        turn_counters=turn_counters,
        vad_mismatch_count=vad_mismatch_count,
        missing_word_timestamps=missing_word_timestamps,
        turn_source=turn_source,
        row_settings=run_config.row_settings_dict(),
        pipeline_timing=pipeline_timing,
    )
    if run_config.write_diagnostics:
        diagnostics["speakerAnalysis"] = speaker_analysis
        diagnostics["preset"] = preset_to_dict(resolve_smoothing_preset(
            speaker_analysis or {},
            speaker_mode=run_config.speaker_mode,
            explicit_preset=speaker_preset,
            speaker_smoothing=run_config.speaker_smoothing,
        ))

    document = build_transcript_document(
        raw_segments=raw_segments,
        display_segments=display_segments,
        word_segments=word_segments,
        speech_turns=speech_turns,
        diarization_segments=diarization_segments,
        source_path=source_path,
        input_dir=input_dir,
        language=language,
        run_config=run_config,
        actual_model=actual_model,
        duration_seconds=duration_seconds,
        diarized=run_config.diarize,
        diagnostics=diagnostics,
        asr_metadata=asr_metadata,
        speaker_preset=speaker_preset,
        turn_source=turn_source,
    )

    if run_config.fail_on_invalid:
        validate_transcript_document(document)

    return document


def process_file(
    source_path: Path,
    input_dir: Path,
    output_dir: Path,
    run_config: RunConfig,
    reuse_align_model: bool,
    align_cache: AlignCache,
    diarize_cache: DiarizeCache,
    reuse_diarize_model: bool,
    force: bool,
) -> tuple[ManifestItem, AlignCache, DiarizeCache]:
    stem = filename_stem(source_path)
    episode_key = stem
    output_path = transcript_output_path(
        source_path, input_dir, output_dir, run_config.preserve_folders
    )
    manifest_rel = transcript_file_manifest_path(output_path, output_dir)
    cache = TranscriptCache(
        run_config.cache_dir,
        cache_schema_version=run_config.cache_schema_version,
        reuse_cache=run_config.reuse_cache,
    )

    needs_work = (
        force
        or run_config.force_asr
        or run_config.force_align
        or run_config.force_diarize
        or run_config.force_turns
        or run_config.rebuild_turns_only
        or run_config.rebuild_rows_only
    )
    if output_path.exists() and not needs_work:
        print(f"SKIP: {source_path.name} (transcript exists)")
        item = ManifestItem(
            source_file=source_path.name,
            filename_stem=stem,
            transcript_file=manifest_rel,
            status="skipped",
            reason="already_exists",
        )
        update_manifest_atomic(output_dir, item, run_config)
        return item, align_cache, diarize_cache

    if run_config.rebuild_rows_only:
        cached_turns = cache.load_stage(episode_key, STAGE_SPEECH_TURNS)
        if not cached_turns:
            raise RuntimeError(
                f"--rebuild-rows-only requires cached speech turns for {episode_key}"
            )
        cached_aligned = cache.load_stage(episode_key, STAGE_ALIGNED) or {}
        cached_words = cache.load_stage(episode_key, STAGE_WORD_SPEAKERS) or {}
        word_segments = cached_words.get("words") or cached_aligned.get("flatWords") or []
        speech_turns = cached_turns.get("speechTurns") or []
        display_segments, word_segments = rebuild_display_rows(
            word_segments,
            strategy=ROW_STRATEGY_V2,
            speech_turns=speech_turns,
            word_segments=word_segments,
            row_min_words=run_config.row_min_words,
            row_max_words=run_config.row_max_words,
            row_hard_max_words=run_config.row_hard_max_words,
            row_pause_sec=run_config.row_pause_sec,
            diarized=run_config.diarize,
        )
        existing = validate_json_file(output_path) if output_path.exists() else {}
        diagnostics = build_episode_diagnostics(
            raw_segments=existing.get("rawSegments", []),
            diarization_segments=existing.get("diarizationSegments", []),
            word_segments=word_segments,
            speech_turns=speech_turns,
            display_segments=display_segments,
            duration_seconds=existing.get("diagnostics", {}).get("durationSeconds", 0),
            diarized=run_config.diarize,
            speaker_analysis=existing.get("diagnostics", {}).get("speakerAnalysis"),
            turn_counters=cached_turns.get("counters"),
            vad_mismatch_count=existing.get("diagnostics", {}).get("vadWordMismatchCount", 0),
            missing_word_timestamps=existing.get("diagnostics", {}).get("missingWordTimestamps", 0),
            turn_source=cached_turns.get("turnSource", "full_pipeline"),
            row_settings=run_config.row_settings_dict(),
        )
        document = {
            **existing,
            "version": TRANSCRIPT_VERSION,
            "segments": display_segments,
            "wordSegments": word_segments,
            "speechTurns": speech_turns,
            "diagnostics": diagnostics,
        }
        save_transcript_json(output_path, document)
        item = manifest_item_from_diag(
            source_file=source_path.name,
            filename_stem=stem,
            transcript_file=manifest_rel,
            status="ok",
            run_config=run_config,
            diag=diagnostics,
        )
        update_manifest_atomic(output_dir, item, run_config)
        return item, align_cache, diarize_cache

    total_steps = 8 if run_config.diarize else 6
    print(f"Processing: {source_path.name}")
    if run_config.device == "cuda" and run_config.diarize_device == "cuda":
        clear_model_caches(align_cache, diarize_cache)
    else:
        free_gpu()

    audio_hash = hash_file(source_path)
    cache.save_stage(
        episode_key,
        STAGE_AUDIO,
        {"sourceFile": source_path.name, "durationSeconds": None},
        audio_hash=audio_hash,
        config_hash=hash_config({"source": source_path.name}),
    )

    effective_batch = resolve_batch_size(
        run_config.batch_size, run_config.device, run_config.diarize
    )
    vad_settings = run_config.vad_settings or default_vad_settings()
    monitor = PipelineMonitor(source_path.name, enabled=run_config.show_progress)

    actual_model = run_config.actual_model or run_config.requested_model
    language = run_config.language or "en"
    duration_seconds = 0.0
    asr_metadata = run_config.asr_metadata(actual_model, effective_batch)
    raw_segments: list[dict[str, Any]] = []
    aligned_flat_words: list[dict[str, Any]] = []
    diarization_segments: list[dict[str, Any]] = []
    word_segments: list[dict[str, Any]] = []
    speech_turns: list[dict[str, Any]] = []
    display_segments: list[dict[str, Any]] = []
    speaker_analysis: dict[str, Any] | None = None
    turn_counters: dict[str, int] = {}
    vad_mismatch_count = 0
    missing_ts = 0
    turn_source = "full_pipeline"
    speaker_preset = run_config.speaker_mode
    audio: Any = None
    asr_result: Any = None
    aligned_result: Any = None
    transcript: dict[str, Any] | None = None

    try:
        skip_gpu = run_config.rebuild_turns_only

        if not skip_gpu:
            asr_payload = None if run_config.force_asr else cache.load_stage(
                episode_key, STAGE_ASR, audio_hash=audio_hash, config_hash=run_config.asr_config_hash()
            )
            if asr_payload:
                print(f"  [cache] ASR loaded for {source_path.name}")
                asr_result = asr_payload["result"]
                actual_model = asr_payload.get("actualModel", actual_model)
                run_config.compute_type = asr_payload.get(
                    "actualComputeType",
                    asr_payload.get("computeType", run_config.requested_compute_type),
                )
                language = asr_result.get("language") or language
                duration_seconds = asr_payload.get("durationSeconds", 0.0)
                import whisperx
                audio = whisperx.load_audio(str(source_path))
                if not duration_seconds:
                    duration_seconds = len(audio) / SAMPLE_RATE
            else:
                print(f"  [1/{total_steps}] Transcribing: {source_path.name}")
                monitor.start_stage("transcribe", run_config.device)
                asr_result, audio, actual_model, duration_seconds, actual_compute = transcribe_audio(
                    source_path,
                    run_config.device,
                    run_config.requested_model,
                    run_config.requested_compute_type,
                    run_config.language,
                    effective_batch,
                    monitor=monitor,
                    vad_settings=vad_settings,
                )
                monitor.end_stage()
                run_config.actual_model = actual_model
                run_config.compute_type = actual_compute
                language = asr_result.get("language") or run_config.language or "en"
                asr_metadata = run_config.asr_metadata(actual_model, effective_batch)
                cache.save_stage(
                    episode_key,
                    STAGE_ASR,
                    {
                        "result": asr_result,
                        "actualModel": actual_model,
                        "actualComputeType": actual_compute,
                        "computeType": actual_compute,
                        "requestedComputeType": run_config.requested_compute_type,
                        "durationSeconds": duration_seconds,
                        "asrMetadata": asr_metadata,
                    },
                    audio_hash=audio_hash,
                    config_hash=run_config.asr_config_hash(),
                )
                vad_regions = derive_regions_from_segments(asr_result.get("segments", []))
                cache.save_stage(
                    episode_key,
                    STAGE_VAD,
                    build_vad_cache_payload(vad_settings, vad_regions),
                    audio_hash=audio_hash,
                    config_hash=hash_config(vad_settings),
                )

            align_payload = None if run_config.force_align else cache.load_stage(
                episode_key,
                STAGE_ALIGNED,
                audio_hash=audio_hash,
                config_hash=run_config.align_config_hash(language),
            )
            if align_payload:
                print(f"  [cache] Alignment loaded for {source_path.name}")
                aligned_result = align_payload["aligned"]
                raw_segments = align_payload.get("rawSegments", [])
                aligned_flat_words = align_payload.get("flatWords", [])
                missing_ts = align_payload.get("missingWordTimestamps", 0)
            else:
                if audio is None:
                    import whisperx
                    audio = whisperx.load_audio(str(source_path))
                    duration_seconds = len(audio) / SAMPLE_RATE
                print(f"  [2/{total_steps}] Aligning: {source_path.name} (device={run_config.align_device})")
                monitor.start_stage("align", run_config.align_device)
                aligned_result, align_cache = align_words(
                    asr_result["segments"],
                    audio,
                    language,
                    run_config.align_device,
                    align_cache,
                    reuse_align_model,
                    monitor=monitor,
                )
                monitor.end_stage()
                raw_segments, aligned_flat_words, missing_ts = extract_raw_segments(aligned_result)
                cache.save_stage(
                    episode_key,
                    STAGE_ALIGNED,
                    {
                        "aligned": aligned_result,
                        "rawSegments": raw_segments,
                        "flatWords": aligned_flat_words,
                        "missingWordTimestamps": missing_ts,
                    },
                    audio_hash=audio_hash,
                    config_hash=run_config.align_config_hash(language),
                )

            vad_payload = cache.load_stage(
                episode_key,
                STAGE_VAD,
                audio_hash=audio_hash,
                config_hash=hash_config(vad_settings),
            )
            if vad_payload:
                aligned_flat_words, vad_mismatch_count = flag_vad_mismatches(
                    aligned_flat_words,
                    vad_payload.get("regions", []),
                )
                monitor.start_stage("vad_export", None)
                monitor.end_stage()

            if run_config.diarize:
                if not run_config.hf_token:
                    raise RuntimeError(HF_SETUP_MSG)
                if (
                    run_config.diarize_device == "cuda"
                    and align_cache.device == "cuda"
                    and align_cache.model is not None
                ):
                    print(
                        "  NOTE: Unloading alignment model from GPU before diarization "
                        "(frees VRAM for pyannote on 6GB GPUs)"
                    )
                    release_align_cache_from_gpu(align_cache)
                    free_gpu()

                diar_payload = None if run_config.force_diarize else cache.load_stage(
                    episode_key,
                    STAGE_DIARIZATION,
                    audio_hash=audio_hash,
                    config_hash=run_config.diarize_config_hash(),
                )
                if diar_payload:
                    print(f"  [cache] Diarization loaded for {source_path.name}")
                    diarization_segments = diar_payload.get("segments", [])
                    require_diarization_segments(
                        diarization_segments,
                        turn_source=turn_source,
                    )
                else:
                    if audio is None:
                        import whisperx
                        audio = whisperx.load_audio(str(source_path))
                    num_speakers = run_config.effective_num_speakers()
                    print(
                        f"  [3/{total_steps}] Diarizing: {source_path.name} "
                        f"(device={run_config.diarize_device}, full audio)"
                    )
                    monitor.start_stage("diarize", run_config.diarize_device)
                    diarization_segments, diarize_cache = run_diarization(
                        audio,
                        run_config.hf_token,
                        run_config.diarize_device,
                        run_config.min_speakers,
                        run_config.max_speakers,
                        diarize_cache,
                        reuse_diarize_model,
                        monitor=monitor,
                        cpu_fallback=run_config.diarize_cpu_fallback,
                        num_speakers=num_speakers,
                    )
                    monitor.end_stage()
                    require_diarization_segments(
                        diarization_segments,
                        turn_source=turn_source,
                    )
                    cache.save_stage(
                        episode_key,
                        STAGE_DIARIZATION,
                        {"segments": diarization_segments},
                        audio_hash=audio_hash,
                        config_hash=run_config.diarize_config_hash(),
                    )
        else:
            aligned_payload = cache.load_stage(
                episode_key,
                STAGE_ALIGNED,
                audio_hash=audio_hash,
            )
            if not aligned_payload:
                raise RuntimeError(
                    f"--rebuild-turns-only requires cached alignment for {episode_key}"
                )
            raw_segments = aligned_payload.get("rawSegments", [])
            aligned_flat_words = aligned_payload.get("flatWords", [])
            missing_ts = aligned_payload.get("missingWordTimestamps", 0)
            duration_seconds = float(
                (cache.load_stage(episode_key, STAGE_ASR, audio_hash=audio_hash) or {}).get("durationSeconds", 0) or 0
            )
            diar_payload = cache.load_stage(
                episode_key,
                STAGE_DIARIZATION,
                audio_hash=audio_hash,
                config_hash=run_config.diarize_config_hash(),
            )
            if run_config.diarize and not diar_payload:
                if output_path.exists():
                    existing_doc = validate_json_file(output_path)
                    version = str(existing_doc.get("version", "1.1.0"))
                    legacy_words = existing_doc.get("wordSegments") or []
                    has_legacy_speakers = any(w.get("speaker") for w in legacy_words)
                    if version < "1.2.0" and has_legacy_speakers and legacy_words:
                        print(
                            "  [legacy] No diarization cache; deriving speechTurns from v1.1 word speakers"
                        )
                        aligned_flat_words = legacy_words
                        turn_source = "legacy_word_speakers"
                        diarization_segments = existing_doc.get("diarizationSegments", [])
                        raw_segments = existing_doc.get("rawSegments", raw_segments)
                    else:
                        raise RuntimeError(
                            f"--rebuild-turns-only requires cached diarization for {episode_key} "
                            "(or existing v1.1 wordSegments with speaker labels)"
                        )
                else:
                    raise RuntimeError(
                        f"--rebuild-turns-only requires cached diarization for {episode_key}"
                    )
            else:
                diarization_segments = (diar_payload or {}).get("segments", [])
                require_diarization_segments(
                    diarization_segments,
                    turn_source=turn_source,
                )

        step_assign = 4 if run_config.diarize and not skip_gpu else 1
        if run_config.diarize:
            print(f"  [{step_assign}/{total_steps}] Assigning speakers")
            monitor.start_stage("speaker_assign", None)
            if turn_source == "legacy_word_speakers":
                word_segments = [dict(w) for w in aligned_flat_words]
            else:
                word_segments = assign_words_from_diarization(
                    aligned_flat_words,
                    diarization_segments,
                    padding_sec=run_config.speaker_assignment_padding_sec,
                )
                require_speaker_assignment(word_segments, turn_source=turn_source)
                cache.save_stage(
                    episode_key,
                    STAGE_WORD_SPEAKERS,
                    {"words": word_segments},
                    audio_hash=audio_hash,
                    config_hash=run_config.diarize_config_hash(),
                )
            monitor.end_stage()
        else:
            word_segments = [dict(w) for w in aligned_flat_words]
            speech_turns = [
                {
                    "turnId": 0,
                    "speaker": None,
                    "speakerClass": "unknown_or_overlap",
                    "startTime": word_segments[0].get("startTime") if word_segments else 0,
                    "endTime": word_segments[-1].get("endTime") if word_segments else 0,
                    "body": " ".join(w["body"] for w in word_segments),
                    "words": word_segments,
                    "wordCount": len(word_segments),
                    "durationSeconds": duration_seconds,
                    "confidence": 0.0,
                    "speakerMargin": 0.0,
                    "source": "no_diarization",
                    "flags": [],
                }
            ] if word_segments else []

        if run_config.diarize:
            print(f"  [{step_assign + 1}/{total_steps}] Analyzing speakers")
            monitor.start_stage("analyze", None)
            explicit_preset = None
            if run_config.speaker_mode in {"normal", "group", "chaotic"}:
                explicit_preset = run_config.speaker_mode
            elif run_config.speaker_mode == "forced-two-host":
                explicit_preset = PRESET_FORCED_TWO_HOST
            speaker_analysis = analyze_speakers(
                word_segments,
                duration_seconds,
                speaker_mode=run_config.speaker_mode,
                explicit_preset=explicit_preset,
            )
            if turn_source == "legacy_word_speakers":
                speaker_analysis["diarizationStability"] = "legacy"
            speaker_preset = speaker_analysis.get("recommendedPreset", "normal")
            monitor.end_stage()

            print(f"  [{step_assign + 2}/{total_steps}] Building speech turns (preset={speaker_preset})")
            monitor.start_stage("turns", None)
            smoothing = resolve_smoothing_preset(
                speaker_analysis,
                speaker_mode=run_config.speaker_mode,
                explicit_preset=explicit_preset,
                speaker_smoothing=run_config.speaker_smoothing,
            )
            speech_turns, turn_counters = build_speech_turns(
                word_segments,
                speaker_analysis,
                smoothing,
                turn_source=turn_source,
            )
            monitor.end_stage()
            cache.save_stage(
                episode_key,
                STAGE_SPEECH_TURNS,
                {"speechTurns": speech_turns, "turnSource": turn_source, "counters": turn_counters},
                audio_hash=audio_hash,
                config_hash=run_config.turns_config_hash(speaker_preset),
            )

        print(f"  [{total_steps - 1}/{total_steps}] Building display rows")
        monitor.start_stage("rows", None)
        if run_config.row_strategy == ROW_STRATEGY_V2:
            display_segments, word_segments = rebuild_display_rows(
                word_segments,
                strategy=ROW_STRATEGY_V2,
                speech_turns=speech_turns,
                word_segments=word_segments,
                row_min_words=run_config.row_min_words,
                row_max_words=run_config.row_max_words,
                row_hard_max_words=run_config.row_hard_max_words,
                row_pause_sec=run_config.row_pause_sec,
                diarized=run_config.diarize,
            )
        else:
            display_segments, word_segments = rebuild_display_rows(
                word_segments,
                strategy=ROW_STRATEGY_V1,
                row_min_words=run_config.row_min_words,
                row_max_words=run_config.row_max_words,
                row_hard_max_words=run_config.row_hard_max_words,
                row_pause_sec=run_config.row_pause_sec,
                turn_pause_sec=run_config.row_turn_pause_sec,
                diarized=run_config.diarize,
            )
        monitor.end_stage()

        pipeline_timing = monitor.to_diagnostics()
        transcript = finalize_from_stages(
            source_path=source_path,
            input_dir=input_dir,
            output_path=output_path,
            run_config=run_config,
            cache=cache,
            episode_key=episode_key,
            audio_hash=audio_hash,
            raw_segments=raw_segments,
            aligned_flat_words=aligned_flat_words,
            diarization_segments=diarization_segments,
            word_segments=word_segments,
            speech_turns=speech_turns,
            display_segments=display_segments,
            duration_seconds=duration_seconds,
            language=language,
            actual_model=actual_model,
            asr_metadata=asr_metadata,
            speaker_analysis=speaker_analysis,
            turn_counters=turn_counters,
            vad_mismatch_count=vad_mismatch_count,
            missing_word_timestamps=missing_ts,
            turn_source=turn_source,
            speaker_preset=speaker_preset,
            pipeline_timing=pipeline_timing,
            monitor=monitor,
        )

        print(f"  [{total_steps}/{total_steps}] Saving: {output_path.name}")
        monitor.start_stage("save", None)
        save_transcript_json(output_path, transcript)
        monitor.end_stage()
    except Exception as exc:
        monitor.fail_current(str(exc))
        raise

    diag = transcript["diagnostics"]
    item = manifest_item_from_diag(
        source_file=source_path.name,
        filename_stem=stem,
        transcript_file=manifest_rel,
        status="ok",
        run_config=run_config,
        diag=diag,
    )
    update_manifest_atomic(output_dir, item, run_config)
    flag_note = ""
    if diag.get("qualityFlags"):
        flag_note = f", flags={','.join(diag['qualityFlags'])}"
    print(
        f"  Done: {diag['wordCount']} words, {diag['segmentCount']} display rows, "
        f"{diag.get('speechTurnCount', 0)} speech turns, "
        f"{diag['rawSegmentCount']} raw segments"
        + (f", {diag.get('detectedSpeakerCount', 0)} speakers" if run_config.diarize else "")
        + f", single-word rows {diag.get('singleWordSegmentPercent', 0)}%"
        + flag_note
    )
    if run_config.show_progress and "pipelineTiming" in diag:
        timing = diag["pipelineTiming"]
        print(f"  Pipeline: {timing['totalSeconds']}s total")
        for stage in timing.get("stages", []):
            dev = f" ({stage['device']})" if stage.get("device") else ""
            print(f"    {stage['name']}{dev}: {stage['elapsedSeconds']}s")

    audio = None
    asr_result = None
    aligned_result = None
    raw_segments = []
    aligned_flat_words = []
    diarization_segments = []
    word_segments = []
    speech_turns = []
    display_segments = []
    transcript = None
    free_gpu()

    return item, align_cache, diarize_cache


def print_summary(stats: RunStats, interrupted: bool = False) -> None:
    label = "Interrupted — run summary" if interrupted else "Run summary"
    print(f"\n{label}:")
    print(f"  Processed: {stats.processed}")
    print(f"  Skipped:   {stats.skipped}")
    print(f"  Failed:    {stats.failed}")
    if interrupted:
        print(f"  Remaining: {stats.remaining}")



def _remove_flag(argv: list[str], flag: str) -> list[str]:
    """Remove a boolean flag from argv without touching similarly named values."""
    return [arg for arg in argv if arg != flag]


def run_isolated_per_file_parent(args: argparse.Namespace) -> int:
    """
    Parent launcher for --isolate-per-file.

    CTranslate2/faster-whisper and pyannote can retain CUDA memory outside
    PyTorch's allocator after a file finishes. torch.cuda.empty_cache() cannot
    reclaim that memory. Running each episode in a fresh Python process gives
    Windows/CUDA a hard reset between files while keeping the same public CLI.
    """
    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    extensions = parse_extensions(args.extensions)
    all_files = discover_audio_files(input_dir, extensions, args.recursive)
    files = apply_file_filters(
        all_files, args.start_after, args.limit, args.test, args.only
    )

    print("Process isolation: ON (fresh Python/CUDA process per episode)")
    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")
    print(f"Found {len(all_files)} audio file(s); {len(files)} queued for this run")
    if not files:
        print("Nothing to process.")
        return 0

    # Child process should run normal single-file mode.
    child_argv = _remove_flag(sys.argv[1:], "--isolate-per-file")
    env = os.environ.copy()
    env["MSSP_TRANSCRIPT_CHILD"] = "1"

    failed = 0
    skipped = 0
    processed = 0

    needs_work = (
        args.force
        or args.force_asr
        or args.force_align
        or args.force_diarize
        or args.force_turns
        or args.rebuild_turns_only
        or args.rebuild_rows_only
    )

    for idx, source_path in enumerate(files, start=1):
        output_path = transcript_output_path(
            source_path, input_dir, output_dir, args.preserve_folders
        )
        if output_path.exists() and not needs_work:
            print(f"SKIP [{idx}/{len(files)}]: {source_path.name} (transcript exists)")
            skipped += 1
            continue

        print()
        print("=" * 80)
        print(f"Isolated episode [{idx}/{len(files)}]: {source_path.name}")
        print("=" * 80)

        cmd = [sys.executable, str(Path(__file__).resolve()), *child_argv, "--only", source_path.name]
        try:
            result = subprocess.run(cmd, env=env)
        except KeyboardInterrupt:
            print("\nInterrupted isolated batch.")
            return 130

        if result.returncode == 0:
            processed += 1
        else:
            failed += 1
            print(
                f"ERROR: isolated episode failed with exit code {result.returncode}: {source_path.name}",
                file=sys.stderr,
            )

    print()
    print("Isolated batch summary:")
    print(f"  processed: {processed}")
    print(f"  skipped:   {skipped}")
    print(f"  failed:    {failed}")
    return 1 if failed else 0


def main() -> int:
    configure_windows_hf_cache()
    load_dotenv_hf_token()
    args = parse_args()
    if args.isolate_per_file and os.environ.get("MSSP_TRANSCRIPT_CHILD") != "1":
        return run_isolated_per_file_parent(args)

    reuse_align_model = args.reuse_align_model
    device = resolve_device(args.device)
    compute_type = resolve_compute_type(args.compute_type, device)
    align_device = resolve_align_device(args.align_device, device)
    diarize_device = resolve_diarize_device(args.diarize_device, device, align_device)
    warn_if_cpu_torch_on_cuda_device(device)
    extensions = parse_extensions(args.extensions)

    if args.cache_version != CACHE_SCHEMA_VERSION:
        print(
            f"ERROR: --cache-version must be {CACHE_SCHEMA_VERSION} (got {args.cache_version})",
            file=sys.stderr,
        )
        return 1

    if args.speaker_mode == "forced-two-host" and args.num_speakers not in (None, 2):
        print("ERROR: forced-two-host mode requires --num-speakers 2 or omitted", file=sys.stderr)
        return 1
    if args.num_speakers is not None and args.speaker_mode != "forced-two-host":
        print(
            "WARNING: --num-speakers is only intended for --speaker-mode forced-two-host",
            file=sys.stderr,
        )

    hf_token = resolve_hf_token(args.hf_token) if args.diarize else None
    if args.diarize and not hf_token:
        print(f"ERROR: {HF_SETUP_MSG}", file=sys.stderr)
        return 1

    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = (SCRIPT_DIR / CACHE_SUBDIR).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)

    if args.preserve_folders and not args.recursive:
        print("NOTE: --preserve-folders is most useful with --recursive for nested archives.")

    if args.align_batch_size is not None:
        print(f"NOTE: --align-batch-size={args.align_batch_size} is reserved for future use.")

    run_config = RunConfig(
        input_dir=input_dir,
        output_dir=output_dir,
        cache_dir=cache_dir,
        requested_model=args.model,
        compute_type=compute_type,
        requested_compute_type=compute_type,
        batch_size=args.batch_size,
        align_batch_size=args.align_batch_size,
        language=args.language,
        device=device,
        align_device=align_device,
        diarize_device=diarize_device,
        recursive=args.recursive,
        preserve_folders=args.preserve_folders,
        diarize=args.diarize,
        hf_token=hf_token,
        min_speakers=args.min_speakers,
        max_speakers=args.max_speakers,
        num_speakers=args.num_speakers,
        speaker_mode=args.speaker_mode,
        speaker_smoothing=args.speaker_smoothing,
        row_strategy=args.row_strategy,
        turn_strategy=args.turn_strategy,
        row_min_words=args.row_min_words,
        row_max_words=args.row_max_words,
        row_hard_max_words=args.row_hard_max_words,
        row_pause_sec=args.row_pause_sec,
        row_turn_pause_sec=args.row_turn_pause_sec,
        show_progress=not args.no_progress,
        diarize_cpu_fallback=args.diarize_cpu_fallback,
        reuse_cache=args.reuse_cache,
        cache_schema_version=args.cache_version,
        vad_settings=default_vad_settings(),
        rebuild_turns_only=args.rebuild_turns_only,
        rebuild_rows_only=args.rebuild_rows_only,
        force_asr=args.force_asr,
        force_align=args.force_align,
        force_diarize=args.force_diarize,
        force_turns=args.force_turns,
        write_diagnostics=args.write_diagnostics,
        fail_on_invalid=args.fail_on_invalid,
        qa_report=args.qa_report,
    )

    try:
        all_files = discover_audio_files(input_dir, extensions, args.recursive)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    files = apply_file_filters(
        all_files, args.start_after, args.limit, args.test, args.only
    )

    if args.reuse_diarize_model is None:
        reuse_diarize_model = args.diarize and not _gpu_vram_under_8gb()
    else:
        reuse_diarize_model = args.reuse_diarize_model

    mode = "diarize + adaptive turns" if args.diarize else "rows only"
    print(f"Device: {device} (ASR) | {align_device} (align)" + (f" | {diarize_device} (diarize)" if args.diarize else ""))
    if args.diarize:
        print(f"Diarize model reuse: {reuse_diarize_model}")
    print(f"ASR: {compute_type} on {device} | cache={cache_dir}")
    print(f"Mode:   {mode} | row={args.row_strategy} | speaker={args.speaker_mode}")
    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")
    print(f"Found {len(all_files)} audio file(s); {len(files)} queued for this run")
    if not files:
        print("Nothing to process.")
        return 0

    stats = RunStats(remaining=len(files))
    align_cache = AlignCache()
    diarize_cache = DiarizeCache()
    interrupted = False
    force = args.force or args.force_asr or args.force_align or args.force_diarize or args.force_turns

    try:
        for i, source_path in enumerate(files):
            stats.remaining = len(files) - i
            try:
                item, align_cache, diarize_cache = process_file(
                    source_path,
                    input_dir,
                    output_dir,
                    run_config,
                    reuse_align_model,
                    align_cache,
                    diarize_cache,
                    reuse_diarize_model,
                    force,
                )
                if item.status == "ok":
                    stats.processed += 1
                elif item.status == "skipped":
                    stats.skipped += 1
            except Exception as exc:
                stats.failed += 1
                stem = filename_stem(source_path)
                output_path = transcript_output_path(
                    source_path, input_dir, output_dir, run_config.preserve_folders
                )
                manifest_rel = transcript_file_manifest_path(output_path, output_dir)
                print(f"ERROR: {source_path.name}: {exc}", file=sys.stderr)
                traceback.print_exc()
                item = ManifestItem(
                    source_file=source_path.name,
                    filename_stem=stem,
                    transcript_file=manifest_rel,
                    status="error",
                    error=str(exc),
                )
                update_manifest_atomic(output_dir, item, run_config)
    except KeyboardInterrupt:
        interrupted = True
        print("\nInterrupted — saving progress...")
        clear_model_caches(align_cache, diarize_cache)
        print_summary(stats, interrupted=True)
        return 130

    clear_model_caches(align_cache, diarize_cache)
    print_summary(stats)
    if args.qa_report:
        report_path = output_dir / "qa-report.json"
        write_qa_report(output_dir / MANIFEST_NAME, report_path)
        print(f"QA report: {report_path}")
    return 1 if stats.failed else 0


if __name__ == "__main__":
    sys.exit(main())
