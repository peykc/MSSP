#!/usr/bin/env python3
"""Append new episodes from update/ into the Holy Trinity catalog files.

Does not overwrite existing episode entries. Manual overwrite only via --overwrite.
Does not auto-run; invoke explicitly when you want a catalog update.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_UPDATE_DIR = SCRIPT_DIR / "update"
TRINITY_STEM = "MSSP - The Holy Trinity"
AUDIO_EXTS = {".mp3", ".m4a", ".m4b", ".aac", ".flac", ".opus", ".ogg", ".wav"}
PATH_PREFIX = r"\Matt and Shane's Secret Podcast\The Holy Trinity"

FILENAME_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})\s+"
    r"(?P<show_type>MSSPOT|MSSP)\s+"
    r"(?:(?P<paytch>PAYTCH)\s+)?"
    r"Ep\.?\s*(?P<episode>\d+(?:\.\d+)?|EX)\s*[-–—]\s*"
    r"(?P<title>.+)\.(?P<ext>[^.]+)$",
    re.IGNORECASE,
)
MD_ROW_RE = re.compile(
    r"^\|\s*(?P<date>\d{4}-\d{2}-\d{2})\s*\|\s*(?P<show_type>[^|]+?)\s*\|\s*"
    r"(?P<paytch>[^|]*?)\s*\|\s*(?P<episode>[^|]+?)\s*\|\s*(?P<title>.*?)\s*\|\s*$"
)
TXT_LINE_RE = re.compile(
    r'^"(?:.*\\)?(?P<filename>[^"\\]+)"\s*$'
)


@dataclass(frozen=True)
class EpisodeMeta:
    date: str
    show_type: str
    is_paytch: bool
    episode: str
    title: str
    filename: str
    path: Path | None = None

    @property
    def identity_key(self) -> tuple:
        """Stable identity used to refuse automatic overwrites."""
        ep = self.episode.upper()
        if ep == "EX":
            return ("ex", self.is_paytch, self.date, self.title.casefold())
        return ("ep", self.is_paytch, ep)


def parse_filename(name: str, path: Path | None = None) -> EpisodeMeta | None:
    match = FILENAME_RE.match(name)
    if not match:
        return None
    return EpisodeMeta(
        date=match.group("date"),
        show_type=normalize_show_type(match.group("show_type")),
        is_paytch=bool(match.group("paytch")),
        episode=match.group("episode"),
        title=match.group("title").strip(),
        filename=name,
        path=path,
    )


def normalize_show_type(raw: str) -> str:
    cleaned = raw.strip().upper()
    if cleaned == "MSSPOT":
        return "MSSPOT"
    return "MSSP"


def probe_duration_seconds(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "ffprobe failed").strip())
    return round(float(result.stdout.strip()), 3)


def load_json_entries(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def load_md_rows(path: Path) -> tuple[str, list[str]]:
    if not path.exists():
        header = "| Date |Type | PAYTCH | Ep. | Episode Title |\n|---|---|---|---:|---|"
        return header, []
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise RuntimeError(f"Unexpected markdown format in {path}")
    header = "\n".join(lines[:2])
    return header, lines[2:]


def load_txt_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def existing_keys_from_json(entries: list[dict]) -> dict[tuple, str]:
    keys: dict[tuple, str] = {}
    for entry in entries:
        meta = parse_filename(entry["filename"])
        if meta:
            keys[meta.identity_key] = meta.filename
    return keys


def existing_keys_from_md(rows: list[str]) -> dict[tuple, str]:
    keys: dict[tuple, str] = {}
    for row in rows:
        match = MD_ROW_RE.match(row)
        if not match:
            continue
        meta = EpisodeMeta(
            date=match.group("date"),
            show_type=normalize_show_type(match.group("show_type")),
            is_paytch=bool(match.group("paytch").strip()),
            episode=match.group("episode").strip(),
            title=match.group("title").strip(),
            filename=row,
        )
        keys[meta.identity_key] = row
    return keys


def existing_keys_from_txt(lines: list[str]) -> dict[tuple, str]:
    keys: dict[tuple, str] = {}
    for line in lines:
        match = TXT_LINE_RE.match(line.strip())
        if not match:
            continue
        meta = parse_filename(match.group("filename"))
        if meta:
            keys[meta.identity_key] = meta.filename
    return keys


def md_row(meta: EpisodeMeta) -> str:
    paytch = "PAYTCH" if meta.is_paytch else ""
    return (
        f"| {meta.date} | {meta.show_type} | {paytch} | {meta.episode} | {meta.title} |"
    )


def txt_line(meta: EpisodeMeta) -> str:
    return f'"{PATH_PREFIX}\\{meta.filename}"'


def json_entry(meta: EpisodeMeta) -> dict:
    assert meta.path is not None
    return {
        "filename": meta.filename,
        "filesize_bytes": meta.path.stat().st_size,
        "duration_seconds": probe_duration_seconds(meta.path),
    }


def list_audio_episodes(update_dir: Path) -> list[EpisodeMeta]:
    episodes: list[EpisodeMeta] = []
    for path in sorted(update_dir.iterdir(), key=lambda p: p.name.lower()):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTS:
            continue
        meta = parse_filename(path.name, path)
        if meta is None:
            print(f"  skip (unparsed audio): {path.name}", flush=True)
            continue
        episodes.append(meta)
    return episodes


def decide_actions(
    episodes: list[EpisodeMeta],
    existing: dict[tuple, str],
    *,
    overwrite: bool,
) -> tuple[list[EpisodeMeta], list[EpisodeMeta], list[EpisodeMeta]]:
    to_add: list[EpisodeMeta] = []
    to_skip: list[EpisodeMeta] = []
    to_replace: list[EpisodeMeta] = []
    for meta in episodes:
        if meta.identity_key in existing:
            if overwrite:
                to_replace.append(meta)
            else:
                to_skip.append(meta)
        else:
            to_add.append(meta)
    return to_add, to_skip, to_replace


def apply_json(
    path: Path,
    entries: list[dict],
    to_add: list[EpisodeMeta],
    to_replace: list[EpisodeMeta],
    *,
    dry_run: bool,
) -> None:
    replace_map = {meta.identity_key: meta for meta in to_replace}
    updated: list[dict] = []
    for entry in entries:
        meta = parse_filename(entry["filename"])
        if meta and meta.identity_key in replace_map:
            updated.append(json_entry(replace_map.pop(meta.identity_key)))
        else:
            updated.append(entry)
    # Any replace targets not found in-place are appended.
    for meta in replace_map.values():
        updated.append(json_entry(meta))
    for meta in to_add:
        updated.append(json_entry(meta))
    if dry_run:
        return
    path.write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")


def apply_md(
    path: Path,
    header: str,
    rows: list[str],
    to_add: list[EpisodeMeta],
    to_replace: list[EpisodeMeta],
    *,
    dry_run: bool,
) -> None:
    replace_map = {meta.identity_key: meta for meta in to_replace}
    updated: list[str] = []
    for row in rows:
        match = MD_ROW_RE.match(row)
        if not match:
            updated.append(row)
            continue
        meta = EpisodeMeta(
            date=match.group("date"),
            show_type=normalize_show_type(match.group("show_type")),
            is_paytch=bool(match.group("paytch").strip()),
            episode=match.group("episode").strip(),
            title=match.group("title").strip(),
            filename=row,
        )
        if meta.identity_key in replace_map:
            updated.append(md_row(replace_map.pop(meta.identity_key)))
        else:
            updated.append(row)
    for meta in replace_map.values():
        updated.append(md_row(meta))
    updated.extend(md_row(meta) for meta in to_add)
    if dry_run:
        return
    body = "\n".join([header, *updated]).rstrip() + "\n"
    path.write_text(body, encoding="utf-8")


def apply_txt(
    path: Path,
    lines: list[str],
    to_add: list[EpisodeMeta],
    to_replace: list[EpisodeMeta],
    *,
    dry_run: bool,
) -> None:
    replace_map = {meta.identity_key: meta for meta in to_replace}
    updated: list[str] = []
    for line in lines:
        match = TXT_LINE_RE.match(line.strip())
        if not match:
            updated.append(line)
            continue
        meta = parse_filename(match.group("filename"))
        if meta and meta.identity_key in replace_map:
            updated.append(txt_line(replace_map.pop(meta.identity_key)))
        else:
            updated.append(line)
    for meta in replace_map.values():
        updated.append(txt_line(meta))
    updated.extend(txt_line(meta) for meta in to_add)
    if dry_run:
        return
    path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-dir",
        type=Path,
        default=DEFAULT_UPDATE_DIR,
        help="Folder containing audio files + Trinity catalogs (default: ./update)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing episode entries that match by identity (manual only)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show planned changes without writing files",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    update_dir = args.update_dir.resolve()
    if not update_dir.is_dir():
        print(f"Update folder not found: {update_dir}", file=sys.stderr)
        return 1

    json_path = update_dir / f"{TRINITY_STEM}.json"
    md_path = update_dir / f"{TRINITY_STEM}.md"
    txt_path = update_dir / f"{TRINITY_STEM}.txt"

    episodes = list_audio_episodes(update_dir)
    if not episodes:
        print(f"No audio episodes found in {update_dir}")
        return 0

    json_entries = load_json_entries(json_path)
    md_header, md_rows = load_md_rows(md_path)
    txt_lines = load_txt_lines(txt_path)

    json_existing = existing_keys_from_json(json_entries)
    md_existing = existing_keys_from_md(md_rows)
    txt_existing = existing_keys_from_txt(txt_lines)

    json_add, json_skip, json_replace = decide_actions(
        episodes, json_existing, overwrite=args.overwrite
    )
    md_add, md_skip, md_replace = decide_actions(
        episodes, md_existing, overwrite=args.overwrite
    )
    txt_add, txt_skip, txt_replace = decide_actions(
        episodes, txt_existing, overwrite=args.overwrite
    )

    print(f"Audio files scanned: {len(episodes)}")
    print(
        f"JSON  add={len(json_add)} skip={len(json_skip)} replace={len(json_replace)}"
    )
    print(f"MD    add={len(md_add)} skip={len(md_skip)} replace={len(md_replace)}")
    print(f"TXT   add={len(txt_add)} skip={len(txt_skip)} replace={len(txt_replace)}")

    for label, items in (
        ("JSON add", json_add),
        ("JSON replace", json_replace),
        ("MD add", md_add),
        ("MD replace", md_replace),
        ("TXT add", txt_add),
        ("TXT replace", txt_replace),
    ):
        for meta in items:
            kind = "PAYTCH" if meta.is_paytch else "main"
            print(f"  [{label}] Ep. {meta.episode} ({kind}) -> {meta.filename}")

    if args.dry_run:
        print("Dry run only; no files written.")
        return 0

    if json_add or json_replace:
        apply_json(json_path, json_entries, json_add, json_replace, dry_run=False)
    if md_add or md_replace:
        apply_md(md_path, md_header, md_rows, md_add, md_replace, dry_run=False)
    if txt_add or txt_replace:
        apply_txt(txt_path, txt_lines, txt_add, txt_replace, dry_run=False)

    print("Catalog update complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
