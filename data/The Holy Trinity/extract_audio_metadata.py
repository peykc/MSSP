#!/usr/bin/env python3
"""Read-only scan of audio files: file size and duration -> JSON."""

import json
import sys
from pathlib import Path

from mutagen import File as MutagenFile

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".wma"}


def duration_seconds(audio_path: Path) -> float | None:
    audio = MutagenFile(audio_path)
    if audio is None or audio.info is None:
        return None
    length = getattr(audio.info, "length", None)
    return round(float(length), 3) if length is not None else None


def scan_folder(folder: Path) -> list[dict]:
    entries = []
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        entries.append(
            {
                "filename": path.name,
                "filesize_bytes": path.stat().st_size,
                "duration_seconds": duration_seconds(path),
            }
        )
    return entries


def main() -> int:
    folder = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent
    output = folder / "audio_metadata.json"

    if not folder.is_dir():
        print(f"Not a directory: {folder}", file=sys.stderr)
        return 1

    data = scan_folder(folder)
    output.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {len(data)} entries to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
