#!/usr/bin/env python3
"""
Export plain-text transcript files for manual ground-truth annotation.

For each transcript JSON produced by the engine, write a .txt containing ONLY
the text of each display segment, one segment per line. You then hand-edit these
files to correct segment boundaries (merge/split lines) and prefix each line with
a speaker label, producing the ground-truth used to score the engine's output.

Usage:
  python make_ground_truth_txt.py                      # all 3 eval episodes
  python make_ground_truth_txt.py --input-dir gen-large-v3 --out-dir eval/ground-truth
  python make_ground_truth_txt.py --only "2016-11-16 MSSPOT Ep. 1 - Inaugral Business"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# The three episodes chosen for the engine-quality benchmark.
EVAL_STEMS = [
    "2016-11-16 MSSPOT Ep. 1 - Inaugral Business",
    "2017-03-16 MSSPOT Ep. 18 - The Oxygen Network",
    "2019-08-15 MSSPOT Ep. 142 - War Room II-Pt 1",
]


def parse_name_map(raw: str | None) -> dict[str, str]:
    """Parse "SPEAKER_04=Matt,SPEAKER_02=Shane" into a dict."""
    if not raw:
        return {}
    out: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" in pair:
            cluster, _, name = pair.partition("=")
            out[cluster.strip()] = name.strip()
    return out


def segment_lines(document: dict, prefill: bool = False, name_map: dict[str, str] | None = None) -> list[str]:
    """One line per display segment. With prefill, append ' | <speaker>' using the
    engine's guess (mapped through name_map) so annotation is a correction pass."""
    name_map = name_map or {}
    lines: list[str] = []
    for seg in document.get("segments", []):
        body = str(seg.get("body", "")).strip()
        if not body:
            continue
        if prefill:
            cluster = str(seg.get("speaker") or "UNKNOWN")
            lines.append(f"{body} | {name_map.get(cluster, cluster)}")
        else:
            lines.append(body)
    return lines


def export(json_path: Path, out_path: Path, prefill: bool = False, name_map: dict[str, str] | None = None) -> int:
    with json_path.open("r", encoding="utf-8") as f:
        document = json.load(f)
    lines = segment_lines(document, prefill=prefill, name_map=name_map)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
        f.write("\n")
    return len(lines)


def continue_export(json_path: Path, out_path: Path, name_map: dict[str, str] | None = None) -> int:
    """Keep the hand-verified lines already in out_path and append prefilled lines
    for the rest of the episode, starting after the last segment the verified text
    covers (found by word-aligning the verified text to the engine output)."""
    from score_transcript import align_pairs, norm, tokenize

    existing_lines = [
        line for line in out_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    if not existing_lines:
        raise SystemExit(f"--continue-existing: {out_path} is empty; run a plain --prefill export instead")

    gt_tokens: list[str] = []
    for line in existing_lines:
        text = line.rpartition("|")[0] if "|" in line else line
        gt_tokens.extend(tokenize(text))

    with json_path.open("r", encoding="utf-8") as f:
        document = json.load(f)
    en_tokens: list[str] = []
    en_seg: list[int] = []
    for seg_idx, seg in enumerate(document.get("segments", [])):
        for w in seg.get("words", []):
            n = norm(str(w.get("body", "")))
            if n:
                en_tokens.append(n)
                en_seg.append(seg_idx)

    pairs = align_pairs(gt_tokens, en_tokens)
    if not pairs:
        raise SystemExit("--continue-existing: verified text does not align to this transcript")
    last_engine_idx = pairs[-1][1]
    start_seg = en_seg[last_engine_idx] + 1

    # Preserve the verified portion untouched next to the working file.
    backup = out_path.with_suffix(".verified.txt")
    backup.write_text("\n".join(existing_lines) + "\n", encoding="utf-8", newline="\n")

    new_lines = segment_lines(document, prefill=True, name_map=name_map)[start_seg:]
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(existing_lines + new_lines))
        f.write("\n")

    print(f"Verified lines kept : {len(existing_lines)}  (backup: {backup.name})")
    print(f"Seam                : verified text ends inside segment {en_seg[last_engine_idx]}; "
          f"appending from segment {start_seg} of {len(document.get('segments', []))}")
    if new_lines:
        print(f"First appended line : {new_lines[0]}")
    print(f"Appended (prefilled): {len(new_lines)}")
    return len(existing_lines) + len(new_lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=SCRIPT_DIR / "gen-large-v3",
                        help="Folder with transcript JSON (default: gen-large-v3)")
    parser.add_argument("--out-dir", type=Path, default=SCRIPT_DIR / "eval" / "ground-truth",
                        help="Folder to write .txt files (default: eval/ground-truth)")
    parser.add_argument("--only", default=None, help="Only this filename stem (repeatable via multiple runs)")
    parser.add_argument(
        "--prefill",
        action="store_true",
        help="Append ' | <speaker>' with the engine's guess so labeling becomes a correction pass",
    )
    parser.add_argument(
        "--name-map",
        default=None,
        help='Cluster-to-name map for --prefill, e.g. "SPEAKER_04=Matt,SPEAKER_02=Shane"',
    )
    parser.add_argument(
        "--continue-existing",
        action="store_true",
        help="Keep hand-verified lines already in the output file and append "
        "prefilled lines for the remainder of the episode",
    )
    args = parser.parse_args()

    input_dir: Path = args.input_dir
    out_dir: Path = args.out_dir
    stems = [args.only] if args.only else EVAL_STEMS

    missing = 0
    for stem in stems:
        json_path = input_dir / f"{stem}.json"
        out_path = out_dir / f"{stem}.txt"
        if not json_path.is_file():
            print(f"MISSING: {json_path} (engine output not found yet)", file=sys.stderr)
            missing += 1
            continue
        if args.continue_existing:
            n = continue_export(json_path, out_path, name_map=parse_name_map(args.name_map))
            print(f"OK: {out_path.name}  ({n} lines total)")
        else:
            n = export(json_path, out_path, prefill=args.prefill, name_map=parse_name_map(args.name_map))
            print(f"OK: {out_path.name}  ({n} segments{', prefilled' if args.prefill else ''})")

    if missing:
        print(f"\n{missing} episode(s) had no JSON yet.", file=sys.stderr)
        return 1
    print(f"\nWrote {len(stems) - missing} ground-truth text file(s) to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
