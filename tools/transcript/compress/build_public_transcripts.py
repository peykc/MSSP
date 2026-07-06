#!/usr/bin/env python3
"""Build compact, player-ready transcript JSON files from master transcripts.

The master files are read-only inputs. Compact files are written beside this
script, using the same filenames as their masters.

Usage:
    python build_public_transcripts.py "D:\\path\\to\\master-transcripts"
    python build_public_transcripts.py "D:\\path\\to\\master-transcripts" --dry-run
    python build_public_transcripts.py . --in-place
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TRANSCRIPT_FORMAT = "mssp-transcript"
OUTPUT_DIR = Path(__file__).resolve().parent
IGNORED_DIRECTORY_NAMES = {".cache", ".git", ".venv", "__pycache__"}


class ExportError(RuntimeError):
    """Raised when a master transcript cannot be safely published."""


@dataclass(frozen=True)
class ExportJob:
    source: Path
    destination: Path
    content: bytes
    source_bytes: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create compact public transcripts from full MSSP master JSON files. "
            "The master files are never changed."
        )
    )
    parser.add_argument(
        "master_folder",
        type=Path,
        help="Folder containing full master transcript JSON files (searched recursively).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report sizes without writing public files.",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help=(
            "Allow full transcript copies already in this public folder to be replaced "
            "with compact versions. All files are validated before any are replaced."
        ),
    )
    return parser.parse_args()


def is_ignored(path: Path, root: Path) -> bool:
    relative_parts = path.relative_to(root).parts[:-1]
    return any(part in IGNORED_DIRECTORY_NAMES for part in relative_parts)


def find_json_files(master_folder: Path) -> list[Path]:
    return sorted(
        path
        for path in master_folder.rglob("*.json")
        if path.is_file() and not is_ignored(path, master_folder)
    )


def read_json(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ExportError(f"Could not read valid JSON from {path}: {error}") from error

    if not isinstance(document, dict):
        raise ExportError(f"Expected a JSON object in {path}")
    return document


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_segments(segments: Any, source: Path) -> list[dict[str, Any]]:
    if not isinstance(segments, list) or not segments:
        raise ExportError(f"Transcript has no segments: {source}")

    for segment_index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ExportError(f"Segment {segment_index} is not an object: {source}")
        if not finite_number(segment.get("startTime")) or not finite_number(segment.get("endTime")):
            raise ExportError(f"Segment {segment_index} has invalid timestamps: {source}")
        if segment["endTime"] < segment["startTime"]:
            raise ExportError(f"Segment {segment_index} ends before it starts: {source}")

        words = segment.get("words")
        if not isinstance(words, list) or not words:
            raise ExportError(f"Segment {segment_index} has no words: {source}")
        for word_index, word in enumerate(words):
            if not isinstance(word, dict) or not str(word.get("body", "")).strip():
                raise ExportError(
                    f"Segment {segment_index}, word {word_index} has no text: {source}"
                )
            if not finite_number(word.get("startTime")) or not finite_number(word.get("endTime")):
                raise ExportError(
                    f"Segment {segment_index}, word {word_index} has invalid timestamps: {source}"
                )
            if word["endTime"] < word["startTime"]:
                raise ExportError(
                    f"Segment {segment_index}, word {word_index} ends before it starts: {source}"
                )

    return segments


def transcript_duration(document: dict[str, Any]) -> int | float | None:
    diagnostics = document.get("diagnostics")
    metadata = document.get("metadata")
    candidates = [
        diagnostics.get("durationSeconds") if isinstance(diagnostics, dict) else None,
        metadata.get("durationSeconds") if isinstance(metadata, dict) else None,
    ]
    return next((value for value in candidates if finite_number(value) and value > 0), None)


def build_public_document(document: dict[str, Any], source: Path) -> dict[str, Any] | None:
    if document.get("format") != TRANSCRIPT_FORMAT:
        return None

    version = document.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ExportError(f"Transcript has no valid version: {source}")

    segments = validate_segments(document.get("segments"), source)
    public_document: dict[str, Any] = {
        "version": version,
        "format": TRANSCRIPT_FORMAT,
    }

    duration = transcript_duration(document)
    if duration is not None:
        public_document["metadata"] = {"durationSeconds": duration}

    # Keep the canonical display segments intact. The player and transcript
    # search both consume these; all other pipeline stages are master-only QA.
    public_document["segments"] = segments
    return public_document


def encode_compact_json(document: dict[str, Any]) -> bytes:
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return f"{text}\n".encode("utf-8")


def prepare_jobs(master_folder: Path) -> tuple[list[ExportJob], int]:
    jobs: list[ExportJob] = []
    destinations: dict[Path, Path] = {}
    skipped = 0

    for source in find_json_files(master_folder):
        document = read_json(source)
        public_document = build_public_document(document, source)
        if public_document is None:
            skipped += 1
            continue

        # The player requests transcripts by episodeKey from one flat folder.
        destination = OUTPUT_DIR / source.name
        previous_source = destinations.get(destination)
        if previous_source is not None:
            raise ExportError(
                "Two master transcripts would produce the same public filename:\n"
                f"  {previous_source}\n"
                f"  {source}"
            )
        destinations[destination] = source
        jobs.append(
            ExportJob(
                source=source,
                destination=destination,
                content=encode_compact_json(public_document),
                source_bytes=source.stat().st_size,
            )
        )

    return jobs, skipped


def atomic_write(path: Path, content: bytes) -> None:
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_name = temporary.name
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def format_size(byte_count: int) -> str:
    value = float(byte_count)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.1f} {unit}"
        value /= 1024
    raise AssertionError("unreachable")


def main() -> int:
    args = parse_args()
    master_folder = args.master_folder.expanduser().resolve()

    if not master_folder.is_dir():
        print(f"ERROR: Master folder does not exist: {master_folder}", file=sys.stderr)
        return 2
    if master_folder == OUTPUT_DIR and not args.in_place:
        print(
            "ERROR: Refusing to replace files in the public output folder without --in-place.",
            file=sys.stderr,
        )
        return 2

    try:
        jobs, skipped = prepare_jobs(master_folder)
    except ExportError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    if not jobs:
        print(f"No {TRANSCRIPT_FORMAT!r} transcript files found under {master_folder}")
        return 1

    total_source = sum(job.source_bytes for job in jobs)
    total_public = sum(len(job.content) for job in jobs)
    reduction = 100 * (1 - total_public / total_source) if total_source else 0

    for job in jobs:
        action = "WOULD WRITE" if args.dry_run else "WROTE"
        if not args.dry_run:
            atomic_write(job.destination, job.content)
        print(
            f"{action}: {job.destination.name} "
            f"({format_size(job.source_bytes)} -> {format_size(len(job.content))})"
        )

    print()
    print(f"Master folder: {master_folder}")
    print(f"Public folder: {OUTPUT_DIR}")
    print(f"Transcripts: {len(jobs)}")
    if skipped:
        print(f"Skipped non-transcript JSON files: {skipped}")
    print(
        f"Total: {format_size(total_source)} -> {format_size(total_public)} "
        f"({reduction:.1f}% smaller)"
    )
    if args.dry_run:
        print("Dry run complete; no files were changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
