#!/usr/bin/env python3
"""Score a generated transcript's speaker accuracy against hand-reviewed ground truth.

Usage:
    python score_speakers.py <corrections.json> <candidate_transcript.json>

corrections.json comes from review.html's "Export corrections" button: a list of
rows the human actually checked by ear, each marked correct / wrong (with the
right speaker) / nonspeech (music, not a real speaker turn -- excluded from scoring).

candidate_transcript.json is any transcript JSON in the same format you already
generate (segments[] with startTime/endTime/speaker), e.g. output from the old
engine, the new engine, or a future tuned version -- whatever you want to test.

Matching is done by time overlap, not by row index, because rebuild_display_rows
can produce a different number of rows between engine versions (longer/shorter
rows, merges, splits). For each reviewed ground-truth row, this script finds the
candidate segment(s) that overlap its time range and checks whether the *majority
of overlapping words* (by duration) agree with the ground-truth speaker.

Output: a single accuracy percentage plus a breakdown, so you can compare configs
run over run without re-reading the transcript by eye every time.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def overlap_duration(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def candidate_speaker_for_window(
    candidate_words: list[dict[str, Any]],
    start: float,
    end: float,
) -> tuple[str | None, dict[str, float]]:
    """Return the speaker with the most overlapping word-duration in [start, end],
    plus a breakdown of overlap-seconds per speaker (for transparency on close calls).
    """
    tally: dict[str, float] = {}
    for w in candidate_words:
        ws, we = w.get("startTime"), w.get("endTime")
        if ws is None or we is None:
            continue
        ov = overlap_duration(start, end, float(ws), float(we))
        if ov <= 0:
            continue
        spk = str(w.get("speaker") or "UNKNOWN")
        tally[spk] = tally.get(spk, 0.0) + ov

    if not tally:
        return None, {}
    winner = max(tally, key=tally.get)
    return winner, tally


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    corrections_path, candidate_path = sys.argv[1], sys.argv[2]
    corrections_doc = load_json(corrections_path)
    candidate_doc = load_json(candidate_path)

    candidate_words = candidate_doc.get("wordSegments")
    if not candidate_words:
        # fall back to flattening segments[] if wordSegments absent
        candidate_words = []
        for seg in candidate_doc.get("segments", []):
            candidate_words.extend(seg.get("words", []))

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

        cand_speaker, tally = candidate_speaker_for_window(candidate_words, start, end)

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
    print()
    print(f"Reviewed rows used for scoring: {scored_total}")
    print(f"  (skipped: {skipped_nonspeech} marked non-speech, {len(no_overlap)} had no time overlap in candidate)")
    print()
    print(f"SPEAKER ACCURACY: {accuracy:.1f}%  ({correct_count}/{scored_total} correct)")
    print()

    if mismatches:
        print(f"--- {len(mismatches)} mismatches ---")
        for m in mismatches:
            print(f"  [{m['time']}] truth={m['truth']!r} candidate={m['candidate']!r}  \"{m['body']}\"")
            print(f"      overlap breakdown: {m['overlap_breakdown']}")
    else:
        print("No mismatches. Clean run against this ground truth set.")

    if no_overlap:
        print()
        print(f"--- {len(no_overlap)} rows had no candidate words in that time window (check alignment/timing) ---")
        for r in no_overlap[:10]:
            print(f"  [{r['startTime']:.1f}-{r['endTime']:.1f}] \"{r['body'][:60]}\"")


if __name__ == "__main__":
    main()
