#!/usr/bin/env python3
"""
Build MSSP collection indexes from one master Holy Trinity path list.

Expected repo layout:

  data/
    organizefilepath.py
    The Holy Trinity/MSSP - The Holy Trinity.txt
    The Old Testament/
    The New Testament/
    The PAYTCH/
    MSSP - Collection Build Report.txt

What it does every time it runs:
  1. Reads: The Holy Trinity/MSSP - The Holy Trinity.txt
  2. Splits it into:
       The Old Testament/MSSP - The Old Testament.txt
       The New Testament/MSSP - The New Testament.txt
       The PAYTCH/MSSP - The PAYTCH.txt
  3. Creates/overwrites Markdown tables for all four txt files:
       The Holy Trinity/MSSP - The Holy Trinity.md
       The Old Testament/MSSP - The Old Testament.md
       The New Testament/MSSP - The New Testament.md
       The PAYTCH/MSSP - The PAYTCH.md
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path, PureWindowsPath
import argparse
import re
import sys

ROOT = Path(__file__).resolve().parent

COLLECTIONS = {
    "holy": {
        "folder": "The Holy Trinity",
        "txt": "MSSP - The Holy Trinity.txt",
        "md": "MSSP - The Holy Trinity.md",
    },
    "old": {
        "folder": "The Old Testament",
        "txt": "MSSP - The Old Testament.txt",
        "md": "MSSP - The Old Testament.md",
    },
    "new": {
        "folder": "The New Testament",
        "txt": "MSSP - The New Testament.txt",
        "md": "MSSP - The New Testament.md",
    },
    "paytch": {
        "folder": "The PAYTCH",
        "txt": "MSSP - The PAYTCH.txt",
        "md": "MSSP - The PAYTCH.md",
    },
}

AUDIO_VIDEO_EXTENSIONS = {
    ".mp3",
    ".m4a",
    ".mp4",
    ".wav",
    ".flac",
    ".aac",
    ".ogg",
    ".opus",
}

FILENAME_RE = re.compile(
    r"""
    ^
    (?P<date>\d{4}-\d{2}-\d{2})
    \s+
    (?P<type>MSSPOT|MSSP)
    (?:\s+(?P<paytch>PAYTCH))?
    \s+
    Ep\.
    \s+
    (?P<ep>EX|\d+(?:\.\d+)?)
    \s+-\s+
    (?P<title>.+)
    $
    """,
    re.VERBOSE,
)


def collection_path(key: str, kind: str) -> Path:
    return ROOT / COLLECTIONS[key]["folder"] / COLLECTIONS[key][kind]


def clean_line(line: str) -> str:
    line = line.strip()
    if line.startswith('"') and line.endswith('"'):
        line = line[1:-1]
    return line.strip()


def quote_path(path_text: str) -> str:
    return f'"{path_text}"'


def get_filename(path_text: str) -> str:
    # Handles Windows-style paths even when this script runs on Linux/macOS in GitHub Actions.
    return PureWindowsPath(path_text).name


def strip_media_extension(filename: str) -> str:
    lowered = filename.lower()
    for ext in sorted(AUDIO_VIDEO_EXTENSIONS, key=len, reverse=True):
        if lowered.endswith(ext):
            return filename[: -len(ext)]
    return filename


def parse_entry(path_line: str):
    cleaned_path = clean_line(path_line)
    filename = get_filename(cleaned_path)
    stem = strip_media_extension(filename)

    match = FILENAME_RE.match(stem)
    if not match:
        return None, {
            "path": cleaned_path,
            "filename": filename,
            "stem": stem,
            "reason": "filename did not match expected MSSP pattern",
        }

    data = match.groupdict()
    return {
        "date": data["date"],
        "type": data["type"],
        "paytch": data["paytch"] or "",
        "ep": data["ep"],
        "title": data["title"].strip(),
        "path": cleaned_path,
        "filename": filename,
        "stem": stem,
    }, None


def route_entry(entry: dict) -> str:
    """
    MSSPOT with no PAYTCH -> Old Testament
    MSSP with no PAYTCH   -> New Testament
    Anything PAYTCH       -> PAYTCH
    """
    if entry["paytch"] == "PAYTCH":
        return "paytch"
    if entry["type"] == "MSSPOT":
        return "old"
    if entry["type"] == "MSSP":
        return "new"
    raise ValueError(f"Unable to route entry: {entry['path']}")


def rewrite_collection_folder(path_text: str, target_folder: str) -> str:
    r"""
    Rewrites only the collection segment in the virtual Windows path.

    Example:
      \Matt and Shane's Secret Podcast\The Holy Trinity\file.mp3
    becomes:
      \Matt and Shane's Secret Podcast\The Old Testament\file.mp3
    """
    parts = path_text.split("\\")
    return "\\".join(target_folder if part == "The Holy Trinity" else part for part in parts)


def read_nonempty_lines(path: Path) -> list[str]:
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_lines(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8", newline="\n")


def escape_md_cell(text: str) -> str:
    return text.replace("|", r"\|").strip()


def build_markdown_table(rows: list[dict]) -> str:
    lines = [
        "| Date |Type | PAYTCH | Ep. | Episode Title |",
        "|---|---|---|---:|---|",
    ]

    for row in rows:
        lines.append(
            f"| {escape_md_cell(row['date'])} "
            f"| {escape_md_cell(row['type'])} "
            f"| {escape_md_cell(row['paytch'])} "
            f"| {escape_md_cell(row['ep'])} "
            f"| {escape_md_cell(row['title'])} |"
        )

    return "\n".join(lines) + "\n"


def make_md_from_txt(txt_path: Path, md_path: Path) -> tuple[int, list[dict]]:
    raw_lines = read_nonempty_lines(txt_path)
    rows = []
    errors = []

    for line in raw_lines:
        row, error = parse_entry(line)
        if row:
            rows.append(row)
        else:
            errors.append(error)

    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(build_markdown_table(rows), encoding="utf-8", newline="\n")
    return len(rows), errors


def write_report(report_path: Path, stats: dict, unparsed: list[dict], md_errors: dict[str, list[dict]]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)

    parsed_entries = stats["parsed_entries"]
    filenames = [entry["filename"] for entry in parsed_entries]
    duplicate_filenames = [name for name, count in Counter(filenames).items() if count > 1]
    decimal_eps = [entry for entry in parsed_entries if re.fullmatch(r"\d+\.\d+", entry["ep"])]

    lines = [
        "MSSP Collection Build Report",
        "============================",
        "",
        f"Root: {ROOT}",
        f"Source: {collection_path('holy', 'txt')}",
        "",
        f"Source input lines: {stats['source_lines']}",
        f"Source parsed lines: {len(parsed_entries)}",
        f"Source unparsed lines: {len(unparsed)}",
        "",
        f"Old Testament txt rows: {stats['split_counts']['old']}",
        f"New Testament txt rows: {stats['split_counts']['new']}",
        f"PAYTCH txt rows: {stats['split_counts']['paytch']}",
        "",
        f"Holy Trinity md rows: {stats['md_counts']['holy']}",
        f"Old Testament md rows: {stats['md_counts']['old']}",
        f"New Testament md rows: {stats['md_counts']['new']}",
        f"PAYTCH md rows: {stats['md_counts']['paytch']}",
        "",
        f"Duplicate filenames: {len(duplicate_filenames)}",
        f"Decimal episode numbers: {len(decimal_eps)}",
        "",
    ]

    if decimal_eps:
        lines.append("Decimal episode rows:")
        lines.extend(f"- {row['date']} {row['type']} Ep. {row['ep']} - {row['title']}" for row in decimal_eps)
        lines.append("")

    if duplicate_filenames:
        lines.append("Duplicate filenames:")
        lines.extend(f"- {name}" for name in duplicate_filenames)
        lines.append("")

    if unparsed:
        lines.append("Unparsed source rows:")
        for err in unparsed:
            lines.append(f"- {err['path']}")
            lines.append(f"  Reason: {err['reason']}")
            lines.append(f"  Parsed stem: {err['stem']}")
        lines.append("")

    for key, errors in md_errors.items():
        if not errors:
            continue
        lines.append(f"Unparsed rows while creating {COLLECTIONS[key]['md']}:")
        for err in errors:
            lines.append(f"- {err['path']}")
            lines.append(f"  Reason: {err['reason']}")
            lines.append(f"  Parsed stem: {err['stem']}")
        lines.append("")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def build_all(fail_on_unparsed: bool = True) -> int:
    source_txt = collection_path("holy", "txt")
    if not source_txt.exists():
        print(f"ERROR: Source file not found: {source_txt}", file=sys.stderr)
        return 1

    raw_lines = read_nonempty_lines(source_txt)
    split_lines = {"old": [], "new": [], "paytch": []}
    parsed_entries = []
    unparsed = []

    for raw_line in raw_lines:
        entry, error = parse_entry(raw_line)
        if not entry:
            unparsed.append(error)
            continue

        parsed_entries.append(entry)
        bucket = route_entry(entry)
        rewritten_path = rewrite_collection_folder(entry["path"], COLLECTIONS[bucket]["folder"])
        split_lines[bucket].append(quote_path(rewritten_path))

    # Overwrite split txt files every run.
    for key in ("old", "new", "paytch"):
        write_lines(collection_path(key, "txt"), split_lines[key])

    # Create/overwrite md files for Holy Trinity + all split collections every run.
    md_counts = {}
    md_errors = {}
    for key in ("holy", "old", "new", "paytch"):
        count, errors = make_md_from_txt(collection_path(key, "txt"), collection_path(key, "md"))
        md_counts[key] = count
        md_errors[key] = errors

    stats = {
        "source_lines": len(raw_lines),
        "parsed_entries": parsed_entries,
        "split_counts": {key: len(lines) for key, lines in split_lines.items()},
        "md_counts": md_counts,
    }

    report_path = ROOT / "MSSP - Collection Build Report.txt"
    write_report(report_path, stats, unparsed, md_errors)

    total_split = sum(stats["split_counts"].values())

    print("MSSP collection build complete.")
    print(f"Source lines: {len(raw_lines)}")
    print(f"Parsed source lines: {len(parsed_entries)}")
    print(f"Split txt total: {total_split}")
    print(f"Old Testament: {stats['split_counts']['old']}")
    print(f"New Testament: {stats['split_counts']['new']}")
    print(f"PAYTCH: {stats['split_counts']['paytch']}")
    print(f"Unparsed source rows: {len(unparsed)}")
    print("")
    for key in ("holy", "old", "new", "paytch"):
        print(f"Wrote: {collection_path(key, 'md')}")
    print(f"Wrote report: {report_path}")

    total_errors = len(unparsed) + sum(len(errors) for errors in md_errors.values())
    if fail_on_unparsed and total_errors:
        print(f"ERROR: Found {total_errors} unparsed rows. See report.", file=sys.stderr)
        return 1

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Split Holy Trinity into Old/New/PAYTCH txt files and create Markdown tables for all MSSP collections."
    )
    parser.add_argument(
        "--allow-unparsed",
        action="store_true",
        help="Do not fail with exit code 1 if unparsed rows are found.",
    )
    args = parser.parse_args()

    return build_all(fail_on_unparsed=not args.allow_unparsed)


if __name__ == "__main__":
    raise SystemExit(main())
