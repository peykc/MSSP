#!/usr/bin/env python3
"""Compare v1.2 manifest metrics against a v1.1 baseline manifest (acceptance QA)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def index_items(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["sourceFile"]: item for item in manifest.get("items", []) if item.get("sourceFile")}


def compare(baseline: dict[str, dict[str, Any]], current: dict[str, dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    shared = sorted(set(baseline) & set(current))[:limit]
    rows: list[dict[str, Any]] = []
    for source in shared:
        b = baseline[source]
        c = current[source]
        rows.append(
            {
                "sourceFile": source,
                "baseline": {
                    "version": b.get("version"),
                    "segmentCount": b.get("segmentCount"),
                    "speechTurnCount": b.get("speechTurnCount"),
                    "microTurnPercent": b.get("microTurnPercent"),
                    "speakerChangesPerMinute": b.get("speakerChangesPerMinute"),
                },
                "current": {
                    "version": c.get("version"),
                    "segmentCount": c.get("segmentCount"),
                    "speechTurnCount": c.get("speechTurnCount"),
                    "microTurnPercent": c.get("microTurnPercent"),
                    "speakerChangesPerMinute": c.get("speakerChangesPerMinute"),
                    "turnSource": c.get("turnSource"),
                    "qualityFlags": c.get("qualityFlags"),
                },
                "delta": {
                    "segmentCount": (c.get("segmentCount") or 0) - (b.get("segmentCount") or 0),
                    "speechTurnCount": (c.get("speechTurnCount") or 0) - (b.get("speechTurnCount") or 0),
                    "microTurnPercent": round(
                        (c.get("microTurnPercent") or 0) - (b.get("microTurnPercent") or 0), 1
                    ),
                },
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline_manifest", help="v1.1 gen/index.json (or backup)")
    parser.add_argument("current_manifest", help="v1.2 gen/index.json after rebuild")
    parser.add_argument("--limit", type=int, default=25, help="Max episodes to compare (default 25)")
    parser.add_argument("--json-out", help="Optional path to write comparison JSON")
    args = parser.parse_args()

    baseline = index_items(load_manifest(Path(args.baseline_manifest)))
    current = index_items(load_manifest(Path(args.current_manifest)))
    rows = compare(baseline, current, args.limit)

    print(f"Compared {len(rows)} shared episodes (limit={args.limit})")
    improved_micro = sum(1 for r in rows if (r["delta"]["microTurnPercent"] or 0) < 0)
    fewer_segments = sum(1 for r in rows if (r["delta"]["segmentCount"] or 0) < 0)
    print(f"  microTurnPercent improved: {improved_micro}/{len(rows)}")
    print(f"  segmentCount reduced:      {fewer_segments}/{len(rows)}")
    print()
    for row in rows[:10]:
        d = row["delta"]
        print(
            f"  {row['sourceFile'][:50]:50} "
            f"segments {d['segmentCount']:+d}  turns {d['speechTurnCount']:+d}  "
            f"micro% {d['microTurnPercent']:+.1f}  turnSource={row['current'].get('turnSource')}"
        )
    if len(rows) > 10:
        print(f"  ... and {len(rows) - 10} more")

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps({"episodeCount": len(rows), "rows": rows}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\nWrote {args.json_out}")


if __name__ == "__main__":
    main()
