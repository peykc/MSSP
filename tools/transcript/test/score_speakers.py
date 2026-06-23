#!/usr/bin/env python3
"""Score speaker accuracy against hand-reviewed ground truth."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def overlap_duration(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def flatten_words(candidate_doc: dict[str, Any]) -> list[dict[str, Any]]:
    words = candidate_doc.get("wordSegments")
    if words:
        return list(words)
    flat: list[dict[str, Any]] = []
    for seg in candidate_doc.get("segments", []):
        flat.extend(seg.get("words", []))
    return flat


def candidate_speaker_for_window(
    candidate_words: list[dict[str, Any]],
    start: float,
    end: float,
) -> tuple[str | None, dict[str, float], float]:
    tally: dict[str, float] = {}
    weight_total = 0.0
    for word in candidate_words:
        ws, we = word.get("startTime"), word.get("endTime")
        if ws is None or we is None:
            continue
        ov = overlap_duration(start, end, float(ws), float(we))
        if ov <= 0:
            continue
        score = float(word.get("speakerAssignmentScore", word.get("speakerConfidence", 1.0)) or 1.0)
        weight = ov * max(score, 0.1)
        spk = str(word.get("speaker") or "UNKNOWN")
        tally[spk] = tally.get(spk, 0.0) + weight
        weight_total += weight

    if not tally:
        return None, {}, 0.0
    winner = max(tally, key=tally.get)
    return winner, tally, weight_total


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        print("Usage: python score_speakers.py <corrections.json> <candidate_transcript.json>")
        sys.exit(1)

    corrections_path, candidate_path = sys.argv[1], sys.argv[2]
    corrections_doc = load_json(corrections_path)
    candidate_doc = load_json(candidate_path)

    turn_source = candidate_doc.get("metadata", {}).get("turn_source") or candidate_doc.get("diagnostics", {}).get("turnSource")
    if turn_source == "legacy_word_speakers":
        print("WARNING: candidate uses legacy_word_speakers — scores are lower-trust.\n")

    candidate_words = flatten_words(candidate_doc)
    rows = corrections_doc.get("corrections", [])
    scored_rows = [r for r in rows if r.get("review") in ("correct", "wrong")]
    skipped_nonspeech = sum(1 for r in rows if r.get("review") == "nonspeech")

    if not scored_rows:
        print("No scoreable rows (need rows marked 'correct' or 'wrong' in the corrections file).")
        sys.exit(1)

    correct_count = 0
    mismatches: list[dict[str, Any]] = []
    no_overlap: list[dict[str, Any]] = []

    for row in scored_rows:
        start, end = row["startTime"], row["endTime"]
        truth_speaker = row["correctSpeaker"]

        cand_speaker, tally, _ = candidate_speaker_for_window(candidate_words, start, end)

        if cand_speaker is None:
            no_overlap.append(row)
            continue

        if cand_speaker == truth_speaker:
            correct_count += 1
        else:
            mismatches.append({
                "time": f"{start:.1f}-{end:.1f}",
                "body": row["body"][:60],
                "truth": truth_speaker,
                "candidate": cand_speaker,
                "overlap_breakdown": {k: round(v, 2) for k, v in tally.items()},
            })

    scored_total = len(scored_rows) - len(no_overlap)
    accuracy = (correct_count / scored_total * 100.0) if scored_total else 0.0

    print(f"Ground truth:  {corrections_doc.get('episode', corrections_path)}")
    print(f"Candidate:     {candidate_path}")
    if turn_source:
        print(f"Turn source:   {turn_source}")
    print()
    print(f"Reviewed rows used for scoring: {scored_total}")
    print(f"  (skipped: {skipped_nonspeech} marked non-speech, {len(no_overlap)} had no time overlap in candidate)")
    print()
    print(f"SPEAKER ACCURACY: {accuracy:.1f}%  ({correct_count}/{scored_total} correct)")
    print()

    if mismatches:
        print(f"--- {len(mismatches)} mismatches ---")
        for mismatch in mismatches:
            print(
                f"  [{mismatch['time']}] truth={mismatch['truth']!r} "
                f"candidate={mismatch['candidate']!r}  \"{mismatch['body']}\""
            )
            print(f"      overlap breakdown: {mismatch['overlap_breakdown']}")
    else:
        print("No mismatches. Clean run against this ground truth set.")

    if no_overlap:
        print()
        print(f"--- {len(no_overlap)} rows had no candidate words in that time window ---")
        for row in no_overlap[:10]:
            print(f"  [{row['startTime']:.1f}-{row['endTime']:.1f}] \"{row['body'][:60]}\"")


if __name__ == "__main__":
    main()
