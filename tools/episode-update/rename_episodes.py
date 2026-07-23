#!/usr/bin/env python3
"""Rename YouTube MSSP downloads to: YYYY-MM-DD MSSP Ep. N - Title.m4a"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SKIP_EPISODES = {"393.1", "393.2", "393.3", "393.4"}
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(.+)\.m4a$", re.IGNORECASE)
EPISODE_RE = re.compile(
    r"(?:Ep\.?\s*-?\s*|MSSP\s+)(\d+(?:\.\d+)?|EX)",
    re.IGNORECASE,
)
TITLE_AFTER_EP_RE = re.compile(
    r"(?:Ep\.?\s*-?\s*|MSSP\s+)(?:\d+(?:\.\d+)?|EX)\s*(?:\([^)]+\))?\s*[-–—]?\s*(.*)",
    re.IGNORECASE,
)
PREFIX_RE = re.compile(
    r"^(?:Matt and Shane_s Secret Podcast|MSSP(?:\s+PAYTCH)?)\s+",
    re.IGNORECASE,
)


def parse_filename(name: str) -> tuple[str, str, str] | None:
    date_match = DATE_RE.match(name)
    if not date_match:
        return None

    date, rest = date_match.group(1), date_match.group(2)
    episode_match = EPISODE_RE.search(rest)
    if not episode_match:
        return None

    episode = episode_match.group(1)
    title_match = TITLE_AFTER_EP_RE.search(rest)
    title = title_match.group(1).strip() if title_match else rest.strip()
    title = PREFIX_RE.sub("", title).strip(" -")
    if not title:
        title = PREFIX_RE.sub("", rest).strip()
    return date, episode, title


def target_name(date: str, episode: str, title: str) -> str:
    return f"{date} MSSP Ep. {episode} - {title}.m4a"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Folder containing M4A files",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show renames without changing files",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    renames: list[tuple[Path, Path]] = []
    skipped = 0
    unparsed: list[str] = []

    for path in sorted(args.dir.glob("*.m4a")):
        parsed = parse_filename(path.name)
        if not parsed:
            unparsed.append(path.name)
            continue

        date, episode, title = parsed
        if episode in SKIP_EPISODES:
            skipped += 1
            continue

        new_name = target_name(date, episode, title)
        if path.name == new_name:
            skipped += 1
            continue

        target = path.with_name(new_name)
        if target.exists() and target != path:
            print(f"Collision: {path.name} -> {new_name}", file=sys.stderr)
            return 1

        renames.append((path, target))

    for src, dst in renames:
        print(f"{src.name} -> {dst.name}")
        if not args.dry_run:
            src.rename(dst)

    print()
    print(f"Renamed: {len(renames)}, skipped: {skipped}, unparsed: {len(unparsed)}")
    if unparsed:
        print("Unparsed files:")
        for name in unparsed:
            print(f"  {name}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
