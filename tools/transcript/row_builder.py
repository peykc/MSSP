"""Rebuild Apple-style display rows from speech turns (v2) or flat words (v1)."""

from __future__ import annotations

import re
from typing import Any

DEFAULT_ROW_HARD_MAX_WORDS = 56
ROW_STRATEGY_V1 = "speaker-turn-v1"
ROW_STRATEGY_V2 = "speaker-turn-v2"
INTERNAL_GAP_SPLIT_SEC = 0.4
# Long enough to indicate likely missing coverage rather than a conversational pause.
LARGE_TRANSCRIPT_GAP_SEC = 5.0
ORPHAN_MAX_WORDS = 2
SENTENCE_BOUNDARY_MIN_GAP_SEC = 0.45
SENTENCE_BOUNDARY_MIN_WORDS = 3
SENTENCE_BOUNDARY_FORCE_SPLIT_WORDS = 4
STANDALONE_SENTENCE_MAX_WORDS = 2
STANDALONE_SENTENCE_MIN_GAP_SEC = 1.0
VALID_SINGLE_WORD_ROW_LEXICON = frozenset({
    "yes", "no", "okay", "yeah", "right", "ok", "yep", "nah", "sure", "what", "huh",
    "hello", "good",
})
NEARBY_ROW_GAP_SEC = 2.0
BAD_SINGLE_WORD_CONTINUATION_GAP_SEC = 0.75
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


def count_words_until_sentence_end(turn_words: list[dict[str, Any]], start_index: int) -> int:
    count = 0
    for index in range(start_index, len(turn_words)):
        count += 1
        if ends_with_sentence_punct(str(turn_words[index].get("body") or "")):
            break
    return count


def should_split_at_sentence_boundary(
    current_words: list[dict[str, Any]],
    next_word: dict[str, Any],
    turn_words: list[dict[str, Any]],
    next_index: int,
) -> bool:
    if not current_words or not next_word:
        return False

    last = current_words[-1]
    if not ends_with_sentence_punct(str(last.get("body") or "")):
        return False

    gap = word_gap(last, next_word)
    current_count = len(current_words)
    next_sentence_words = count_words_until_sentence_end(turn_words, next_index)

    if current_count <= STANDALONE_SENTENCE_MAX_WORDS:
        return gap >= STANDALONE_SENTENCE_MIN_GAP_SEC

    if current_count >= SENTENCE_BOUNDARY_MIN_WORDS and gap >= SENTENCE_BOUNDARY_MIN_GAP_SEC:
        return True
    if next_sentence_words >= SENTENCE_BOUNDARY_FORCE_SPLIT_WORDS:
        return True
    if current_count >= SENTENCE_BOUNDARY_FORCE_SPLIT_WORDS:
        return True
    return False


def normalize_row_word_body(body: str) -> str:
    return str(body or "").strip().lower().rstrip(".,!?;:")


def segment_gap(prev: dict[str, Any] | None, nxt: dict[str, Any] | None) -> float:
    if not prev or not nxt:
        return float("inf")
    prev_end = prev.get("endTime")
    next_start = nxt.get("startTime")
    if prev_end is None or next_start is None:
        return float("inf")
    return float(next_start) - float(prev_end)


def row_forms_sentence_continuation(segment: dict[str, Any] | None) -> bool:
    if not segment:
        return False
    body = str(segment.get("body") or "").strip()
    if not body:
        return False
    return not ends_with_sentence_punct(body)


def is_bad_single_word_row(
    segment: dict[str, Any],
    prev_segment: dict[str, Any] | None,
    next_segment: dict[str, Any] | None,
) -> bool:
    words = segment.get("words") or []
    if len(words) != 1:
        return False

    body = normalize_row_word_body(str(words[0].get("body") or ""))
    if not body or body in VALID_SINGLE_WORD_ROW_LEXICON:
        return False

    if prev_segment is None and next_segment is None:
        return False

    gap_prev = segment_gap(prev_segment, segment)
    gap_next = segment_gap(segment, next_segment)
    if gap_prev > NEARBY_ROW_GAP_SEC and gap_next > NEARBY_ROW_GAP_SEC:
        return False

    prev_continues = row_forms_sentence_continuation(prev_segment)
    next_continues = row_forms_sentence_continuation(next_segment)
    if prev_continues or next_continues:
        return True

    if (
        prev_segment
        and ends_with_sentence_punct(str(prev_segment.get("body") or ""))
        and next_segment
        and gap_next <= BAD_SINGLE_WORD_CONTINUATION_GAP_SEC
        and not ends_with_sentence_punct(str(segment.get("body") or ""))
    ):
        return True

    return False


def count_bad_single_word_rows(display_segments: list[dict[str, Any]]) -> int:
    return sum(
        1
        for index, segment in enumerate(display_segments)
        if is_bad_single_word_row(
            segment,
            display_segments[index - 1] if index > 0 else None,
            display_segments[index + 1] if index + 1 < len(display_segments) else None,
        )
    )


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
            if next_word and should_split_at_sentence_boundary(row_words, next_word, turn_words, i + 1):
                segments.append(_make_segment(row_words, turn_id, diarized))
                row_words = []
            elif len(row_words) >= row_min_words:
                if next_word is not None and word_gap(word, next_word) > row_pause_sec:
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
    bad_single_word_segments = count_bad_single_word_rows(display_segments)
    bad_single_word_pct = (bad_single_word_segments / seg_count * 100.0) if seg_count else 0.0

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

    timed_segments = sorted(
        (
            segment
            for segment in display_segments
            if segment.get("startTime") is not None and segment.get("endTime") is not None
        ),
        key=lambda segment: float(segment["startTime"]),
    )
    max_transcript_gap = 0.0
    large_transcript_gaps: list[dict[str, Any]] = []
    for previous, current in zip(timed_segments, timed_segments[1:]):
        gap_start = float(previous["endTime"])
        gap_end = float(current["startTime"])
        gap_duration = gap_end - gap_start
        if gap_duration > max_transcript_gap:
            max_transcript_gap = gap_duration
        if gap_duration >= LARGE_TRANSCRIPT_GAP_SEC:
            large_transcript_gaps.append(
                {
                    "startTime": round(gap_start, 3),
                    "endTime": round(gap_end, 3),
                    "duration": round(gap_duration, 3),
                    "previous": str(previous.get("body") or ""),
                    "next": str(current.get("body") or ""),
                }
            )

    quality_flags: list[str] = []
    if diarized:
        if len(speaker_counts) > 6:
            quality_flags.append("high_speaker_count")
        if single_word_pct > 20.0:
            quality_flags.append("row_fragmentation_failure")
        elif single_word_pct > 10.0:
            quality_flags.append("high_single_word_segments")
        if bad_single_word_pct > 5.0:
            quality_flags.append("bad_single_word_rows")
        if unknown_pct > 1.0:
            quality_flags.append("high_unknown_speaker")
    if large_transcript_gaps:
        quality_flags.append("large_transcript_gap")

    result: dict[str, Any] = {
        "singleWordSegmentCount": single_word_segments,
        "singleWordSegmentPercent": round(single_word_pct, 1),
        "badSingleWordSegmentCount": bad_single_word_segments,
        "badSingleWordSegmentPercent": round(bad_single_word_pct, 1),
        "maxRowWordCount": max_row_word_count,
        "unknownWordPercent": round(unknown_pct, 1),
        "topSpeakerWordShare": round(top_share, 1),
        "maxTranscriptGapSeconds": round(max_transcript_gap, 3),
        "largeTranscriptGapCount": len(large_transcript_gaps),
        "largeTranscriptGaps": large_transcript_gaps,
        "qualityFlags": quality_flags,
    }
    if row_settings is not None:
        result["row_settings"] = row_settings
    return result


def _word_identity(word: dict[str, Any]) -> tuple[str, float, float] | None:
    body = str(word.get("body", "")).strip()
    start = word.get("startTime")
    end = word.get("endTime")
    if not body or start is None or end is None:
        return None
    return body, float(start), float(end)


def verify_row_word_integrity(
    display_segments: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
) -> dict[str, Any]:
    canonical = {_word_identity(w) for w in word_segments if _word_identity(w)}
    total = 0
    matched = 0
    for segment in display_segments:
        for word in segment.get("words", []):
            ident = _word_identity(word)
            if ident is None:
                continue
            total += 1
            if ident in canonical:
                matched += 1
    pct = (matched / total * 100.0) if total else 100.0
    return {
        "ok": total == matched,
        "matched": matched,
        "total": total,
        "rowWordIntegrityPercent": round(pct, 2),
    }


def _display_word_from_canonical(word: dict[str, Any], turn_id: int | None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "body": word["body"],
        "startTime": word.get("startTime"),
        "endTime": word.get("endTime"),
    }
    if word.get("speaker") is not None:
        entry["speaker"] = word.get("speaker")
    if turn_id is not None:
        entry["turnId"] = turn_id
    return entry


def build_display_rows_from_turns(
    speech_turns: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
    *,
    strategy: str = ROW_STRATEGY_V2,
    row_min_words: int = 6,
    row_max_words: int = 40,
    row_hard_max_words: int = DEFAULT_ROW_HARD_MAX_WORDS,
    row_pause_sec: float = 1.5,
    diarized: bool = True,
) -> list[dict[str, Any]]:
    if strategy != ROW_STRATEGY_V2:
        raise ValueError(f"build_display_rows_from_turns requires {ROW_STRATEGY_V2}")

    segments: list[dict[str, Any]] = []
    for turn in speech_turns:
        turn_words = turn.get("words") or []
        turn_id = turn.get("turnId")
        speaker = turn.get("speaker")
        if not turn_words:
            continue
        rows = split_turn_into_rows(
            turn_words,
            turn_id,
            diarized,
            row_min_words,
            row_max_words,
            row_hard_max_words,
            row_pause_sec,
        )
        for row in rows:
            if speaker and diarized:
                row["speaker"] = speaker
            if turn_id is not None:
                row["turnId"] = turn_id
            row["words"] = [
                _display_word_from_canonical(w, turn_id)
                for w in row.get("words", [])
            ]
        segments.extend(rows)

    segments = merge_orphan_rows(segments, row_pause_sec, diarized)
    return segments


def rebuild_display_rows(
    words: list[dict[str, Any]],
    strategy: str = ROW_STRATEGY_V1,
    row_min_words: int = 6,
    row_max_words: int = 40,
    row_hard_max_words: int = DEFAULT_ROW_HARD_MAX_WORDS,
    row_pause_sec: float = 1.5,
    turn_pause_sec: float = 2.5,
    diarized: bool = False,
    speech_turns: list[dict[str, Any]] | None = None,
    word_segments: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (display_segments, flat_word_segments)."""
    if strategy == ROW_STRATEGY_V2:
        if speech_turns is None:
            raise ValueError(f"{ROW_STRATEGY_V2} requires speech_turns")
        canonical_words = word_segments if word_segments is not None else words
        display_segments = build_display_rows_from_turns(
            speech_turns,
            canonical_words,
            strategy=strategy,
            row_min_words=row_min_words,
            row_max_words=row_max_words,
            row_hard_max_words=row_hard_max_words,
            row_pause_sec=row_pause_sec,
            diarized=diarized,
        )
        return display_segments, list(canonical_words)

    if strategy != ROW_STRATEGY_V1:
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
    word_segments_out = segments_to_word_segments(segments)
    return segments, word_segments_out
