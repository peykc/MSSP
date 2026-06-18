"""Rebuild Apple-style display rows from flat word lists (speaker-turn-v1)."""

from __future__ import annotations

import re
from typing import Any

DEFAULT_ROW_HARD_MAX_WORDS = 56
INTERNAL_GAP_SPLIT_SEC = 0.4
ORPHAN_MAX_WORDS = 2
SENTENCE_END_RE = re.compile(r"[.!?]$")
CLAUSE_END_RE = re.compile(r"[,;:\u2014\u2013-]$")
PUNCT_SPACING_RE = re.compile(r"\s+([,!?;:.])")


def normalize_punctuation_spacing(text: str) -> str:
    """Collapse space before punctuation: 'Hello , world ?' -> 'Hello, world?'"""
    return PUNCT_SPACING_RE.sub(r"\1", text).strip()


def ends_with_sentence_punct(body: str) -> bool:
    return bool(SENTENCE_END_RE.search(body.strip()))


def ends_with_clause_punct(body: str) -> bool:
    return bool(CLAUSE_END_RE.search(body.strip()))


def word_gap(prev: dict[str, Any], nxt: dict[str, Any]) -> float:
    prev_end = prev.get("endTime")
    next_start = nxt.get("startTime")
    if prev_end is None or next_start is None:
        return 0.0
    return float(next_start) - float(prev_end)


def join_row_body(words: list[dict[str, Any]]) -> str:
    return normalize_punctuation_spacing(" ".join(w["body"] for w in words))


def normalize_speakers(
    words: list[dict[str, Any]],
    row_pause_sec: float,
    diarized: bool,
) -> tuple[list[dict[str, Any]], int]:
    """Fill missing speaker via inheritance or UNKNOWN. Returns (words, missing_count)."""
    if not diarized:
        return words, 0

    missing_count = 0
    result: list[dict[str, Any]] = []
    prev_speaker: str | None = None
    prev_word: dict[str, Any] | None = None

    for raw in words:
        word = dict(raw)
        speaker = word.get("speaker")
        if not speaker:
            if (
                prev_word is not None
                and prev_speaker
                and word_gap(prev_word, word) < row_pause_sec
            ):
                word["speaker"] = prev_speaker
            else:
                word["speaker"] = "UNKNOWN"
                missing_count += 1
        else:
            prev_speaker = str(speaker)
        result.append(word)
        prev_word = word

    return result, missing_count


def assign_turn_ids(
    words: list[dict[str, Any]],
    turn_pause_sec: float,
    diarized: bool,
) -> list[dict[str, Any]]:
    """Phase 1: assign turnId per word (speaker change or major pause only)."""
    if not diarized:
        return [dict(w) for w in words]

    result: list[dict[str, Any]] = []
    turn_id = 0
    for i, raw in enumerate(words):
        word = dict(raw)
        if i > 0:
            prev = words[i - 1]
            gap = word_gap(prev, raw)
            speaker_changed = raw.get("speaker") != prev.get("speaker")
            if speaker_changed or gap > turn_pause_sec:
                turn_id += 1
        word["turnId"] = turn_id
        result.append(word)
    return result


def group_by_turn(words: list[dict[str, Any]], diarized: bool) -> list[tuple[int | None, list[dict[str, Any]]]]:
    if not diarized:
        return [(None, words)]

    turns: list[tuple[int | None, list[dict[str, Any]]]] = []
    current: list[dict[str, Any]] = []
    current_turn: int | None = None
    for word in words:
        turn_id = word.get("turnId", 0)
        if current and turn_id != current_turn:
            turns.append((current_turn, current))
            current = []
        current_turn = turn_id
        current.append(word)
    if current:
        turns.append((current_turn, current))
    return turns


def _make_segment(
    row_words: list[dict[str, Any]],
    turn_id: int | None,
    diarized: bool,
) -> dict[str, Any]:
    seg_start = row_words[0].get("startTime")
    seg_end = row_words[-1].get("endTime")
    row_speaker = row_words[0].get("speaker") if diarized else None

    words_out: list[dict[str, Any]] = []
    for w in row_words:
        entry: dict[str, Any] = {
            "body": w["body"],
            "startTime": w.get("startTime"),
            "endTime": w.get("endTime"),
        }
        if diarized:
            entry["speaker"] = w.get("speaker", row_speaker)
            entry["turnId"] = turn_id
        words_out.append(entry)

    segment: dict[str, Any] = {
        "startTime": seg_start,
        "endTime": seg_end,
        "body": join_row_body(row_words),
        "words": words_out,
    }
    if diarized:
        segment["speaker"] = row_speaker
        segment["turnId"] = turn_id
    return segment


def _split_at_best_boundary(
    row_words: list[dict[str, Any]],
    row_min_words: int,
    row_max_words: int,
    row_hard_max_words: int,
    internal_gap_sec: float = INTERNAL_GAP_SPLIT_SEC,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split an over-long row at the best spoken-thought boundary."""
    n = len(row_words)
    if n <= 1:
        return row_words, []

    max_left = min(n - 1, row_hard_max_words - 1)
    mid_target = max(row_min_words, row_max_words // 2)

    # Priority 1: sentence boundary, left size in [row_max_words, row_hard_max_words)
    for left_count in range(max_left, row_max_words - 1, -1):
        if ends_with_sentence_punct(row_words[left_count - 1]["body"]):
            return row_words[:left_count], row_words[left_count:]

    # Priority 2: sentence boundary, left size in [mid_target, row_max_words)
    for left_count in range(min(max_left, row_max_words - 1), mid_target - 1, -1):
        if ends_with_sentence_punct(row_words[left_count - 1]["body"]):
            return row_words[:left_count], row_words[left_count:]

    # Priority 3: clause punctuation, left size >= mid_target
    for left_count in range(max_left, mid_target - 1, -1):
        if ends_with_clause_punct(row_words[left_count - 1]["body"]):
            return row_words[:left_count], row_words[left_count:]

    # Priority 4: any remaining sentence boundary >= row_min_words
    for left_count in range(min(max_left, mid_target - 1), row_min_words - 1, -1):
        if ends_with_sentence_punct(row_words[left_count - 1]["body"]):
            return row_words[:left_count], row_words[left_count:]

    # Priority 5: largest internal gap (prefer latter half, then whole row)
    def _best_gap_split(start_idx: int) -> int:
        best_gap = 0.0
        best_after = -1
        for i in range(start_idx, n - 1):
            gap = word_gap(row_words[i], row_words[i + 1])
            if gap >= internal_gap_sec and gap > best_gap:
                best_gap = gap
                best_after = i
        return best_after

    split_after = _best_gap_split(n // 2)
    if split_after < 0:
        split_after = _best_gap_split(row_min_words - 1)
    if split_after >= 0:
        left_count = split_after + 1
        return row_words[:left_count], row_words[left_count:]

    # Priority 6: hard split at ceiling
    split_at = min(n, row_hard_max_words)
    return row_words[:split_at], row_words[split_at:]


def split_turn_into_rows(
    turn_words: list[dict[str, Any]],
    turn_id: int | None,
    diarized: bool,
    row_min_words: int,
    row_max_words: int,
    row_hard_max_words: int,
    row_pause_sec: float,
    internal_gap_sec: float = INTERNAL_GAP_SPLIT_SEC,
) -> list[dict[str, Any]]:
    """Phase 2: split one speaker turn into display rows (never crosses turn boundary)."""
    if not turn_words:
        return []

    segments: list[dict[str, Any]] = []
    row_words: list[dict[str, Any]] = []
    i = 0

    while i < len(turn_words):
        word = turn_words[i]
        if row_words:
            gap = word_gap(row_words[-1], word)
            if gap > row_pause_sec:
                segments.append(_make_segment(row_words, turn_id, diarized))
                row_words = []

        row_words.append(word)

        if len(row_words) >= row_hard_max_words:
            left, right = _split_at_best_boundary(
                row_words,
                row_min_words,
                row_max_words,
                row_hard_max_words,
                internal_gap_sec,
            )
            segments.append(_make_segment(left, turn_id, diarized))
            row_words = right
            i += 1
            continue

        if ends_with_sentence_punct(word["body"]):
            next_word = turn_words[i + 1] if i + 1 < len(turn_words) else None
            should_split = len(row_words) >= row_min_words
            if next_word is not None and word_gap(word, next_word) > row_pause_sec:
                should_split = True
            if should_split:
                segments.append(_make_segment(row_words, turn_id, diarized))
                row_words = []

        i += 1

    if row_words:
        segments.append(_make_segment(row_words, turn_id, diarized))
    return segments


def _segments_can_merge(
    left: dict[str, Any],
    right: dict[str, Any],
    merge_gap_sec: float,
    diarized: bool,
) -> bool:
    if not left["words"] or not right["words"]:
        return False
    if diarized:
        if left.get("speaker") != right.get("speaker"):
            return False
        if left.get("turnId") != right.get("turnId"):
            return False
    gap = word_gap(left["words"][-1], right["words"][0])
    return gap <= merge_gap_sec


def _merge_segments(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    merged_words = [dict(w) for w in left["words"]] + [dict(w) for w in right["words"]]
    segment: dict[str, Any] = {
        "startTime": merged_words[0].get("startTime"),
        "endTime": merged_words[-1].get("endTime"),
        "body": join_row_body(merged_words),
        "words": merged_words,
    }
    if "speaker" in left:
        segment["speaker"] = left["speaker"]
    if "turnId" in left:
        segment["turnId"] = left["turnId"]
    return segment


def merge_orphan_rows(
    segments: list[dict[str, Any]],
    row_pause_sec: float,
    diarized: bool,
) -> list[dict[str, Any]]:
    """Merge 1–2 word orphan rows into neighbors when speaker/turn and gap allow."""
    if len(segments) < 2:
        return segments

    merged = [dict(seg) for seg in segments]
    for seg in merged:
        seg["words"] = [dict(w) for w in seg["words"]]

    changed = True
    while changed:
        changed = False
        idx = 0
        while idx < len(merged):
            seg = merged[idx]
            if len(seg["words"]) <= ORPHAN_MAX_WORDS:
                if idx + 1 < len(merged) and _segments_can_merge(seg, merged[idx + 1], row_pause_sec, diarized):
                    merged[idx] = _merge_segments(seg, merged[idx + 1])
                    merged.pop(idx + 1)
                    changed = True
                    continue
                if idx > 0 and _segments_can_merge(merged[idx - 1], seg, row_pause_sec, diarized):
                    merged[idx - 1] = _merge_segments(merged[idx - 1], seg)
                    merged.pop(idx)
                    changed = True
                    continue
            idx += 1

    return merged


def segments_to_word_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for seg in segments:
        for w in seg["words"]:
            flat.append(dict(w))
    return flat


def compute_display_diagnostics(
    display_segments: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
    diarized: bool,
    row_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Quality metrics for batch outlier review."""
    seg_count = len(display_segments)
    word_count = len(word_segments)
    single_word_segments = sum(1 for s in display_segments if len(s.get("words", [])) == 1)
    single_word_pct = (single_word_segments / seg_count * 100.0) if seg_count else 0.0

    row_word_counts = [len(s.get("words", [])) for s in display_segments]
    max_row_word_count = max(row_word_counts) if row_word_counts else 0

    unknown_words = sum(1 for w in word_segments if w.get("speaker") == "UNKNOWN")
    unknown_pct = (unknown_words / word_count * 100.0) if word_count else 0.0

    speaker_counts: dict[str, int] = {}
    for w in word_segments:
        sp = w.get("speaker")
        if sp:
            speaker_counts[str(sp)] = speaker_counts.get(str(sp), 0) + 1

    top_share = 0.0
    if speaker_counts and word_count:
        top_share = max(speaker_counts.values()) / word_count * 100.0

    quality_flags: list[str] = []
    if diarized:
        if len(speaker_counts) > 6:
            quality_flags.append("high_speaker_count")
        if single_word_pct > 10.0:
            quality_flags.append("high_single_word_segments")
        if unknown_pct > 1.0:
            quality_flags.append("high_unknown_speaker")

    result: dict[str, Any] = {
        "singleWordSegmentCount": single_word_segments,
        "singleWordSegmentPercent": round(single_word_pct, 1),
        "maxRowWordCount": max_row_word_count,
        "unknownWordPercent": round(unknown_pct, 1),
        "topSpeakerWordShare": round(top_share, 1),
        "qualityFlags": quality_flags,
    }
    if row_settings is not None:
        result["row_settings"] = row_settings
    return result


def rebuild_display_rows(
    words: list[dict[str, Any]],
    strategy: str = "speaker-turn-v1",
    row_min_words: int = 6,
    row_max_words: int = 40,
    row_hard_max_words: int = DEFAULT_ROW_HARD_MAX_WORDS,
    row_pause_sec: float = 1.5,
    turn_pause_sec: float = 2.5,
    diarized: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (display_segments, flat_word_segments).

    Pipeline: words → turn assignment → per-turn row splits → orphan merge.
    """
    if strategy != "speaker-turn-v1":
        raise ValueError(f"Unknown row strategy: {strategy}")

    if not words:
        return [], []

    tagged = assign_turn_ids(words, turn_pause_sec, diarized)
    segments: list[dict[str, Any]] = []
    for turn_id, turn_words in group_by_turn(tagged, diarized):
        segments.extend(
            split_turn_into_rows(
                turn_words,
                turn_id,
                diarized,
                row_min_words,
                row_max_words,
                row_hard_max_words,
                row_pause_sec,
            )
        )

    segments = merge_orphan_rows(segments, row_pause_sec, diarized)
    word_segments = segments_to_word_segments(segments)
    return segments, word_segments
