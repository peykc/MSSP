"""Word-to-diarization overlap scoring with clamped assignment scores."""

from __future__ import annotations

from typing import Any

LOW_ASSIGNMENT_SCORE = 0.55
LOW_ASSIGNMENT_MARGIN = 0.20
DEFAULT_PADDING_SEC = 0.10
NEARBY_SCORE_MIN = 0.25
NEARBY_SCORE_MAX = 0.45


def overlap_duration(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def word_time_span(word: dict[str, Any]) -> tuple[float, float] | None:
    start = word.get("startTime")
    end = word.get("endTime")
    if start is None or end is None:
        return None
    start_f = float(start)
    end_f = float(end)
    if end_f <= start_f:
        return None
    return start_f, end_f


def proximity_score(padded_overlap: float, padding_sec: float) -> float:
    """Low-trust score for words near but not overlapping a diarization segment."""
    span = max(padding_sec * 2.0, 0.01)
    ratio = clamp01(padded_overlap / span)
    return NEARBY_SCORE_MIN + ratio * (NEARBY_SCORE_MAX - NEARBY_SCORE_MIN)


def score_word_candidates(
    word: dict[str, Any],
    diarization_segments: list[dict[str, Any]],
    *,
    padding_sec: float = DEFAULT_PADDING_SEC,
) -> tuple[dict[str, float], dict[str, str]]:
    span = word_time_span(word)
    if span is None:
        return {}, {}
    ws, we = span
    duration = we - ws
    if duration <= 0:
        return {}, {}

    padded_start = ws - padding_sec
    padded_end = we + padding_sec
    tally: dict[str, float] = {}
    sources: dict[str, str] = {}

    for segment in diarization_segments:
        speaker = segment.get("speaker")
        seg_start = segment.get("startTime")
        seg_end = segment.get("endTime")
        if not speaker or seg_start is None or seg_end is None:
            continue
        seg_start_f = float(seg_start)
        seg_end_f = float(seg_end)
        if seg_end_f <= seg_start_f:
            continue

        search_overlap = overlap_duration(padded_start, padded_end, seg_start_f, seg_end_f)
        if search_overlap <= 0:
            continue

        speaker_key = str(speaker)
        raw_overlap = overlap_duration(ws, we, seg_start_f, seg_end_f)
        if raw_overlap > 0:
            score = clamp01(raw_overlap / duration)
            if score >= tally.get(speaker_key, 0.0):
                tally[speaker_key] = score
                sources[speaker_key] = "diarization_overlap"
        else:
            score = proximity_score(search_overlap, padding_sec)
            if score > tally.get(speaker_key, 0.0):
                tally[speaker_key] = score
                sources[speaker_key] = "diarization_nearby"

    return tally, sources


OVERLAP_TOP_MIN_SCORE = 0.35
OVERLAP_SECOND_MIN_SCORE = 0.25
OVERLAP_MARGIN_MAX = 0.15


def detect_overlap_possible(candidates: dict[str, float]) -> bool:
    if len(candidates) < 2:
        return False
    ranked_scores = sorted(candidates.values(), reverse=True)
    top_score = ranked_scores[0]
    second_score = ranked_scores[1]
    margin = top_score - second_score
    return (
        top_score >= OVERLAP_TOP_MIN_SCORE
        and second_score >= OVERLAP_SECOND_MIN_SCORE
        and margin <= OVERLAP_MARGIN_MAX
    )


def pick_assignment(
    candidates: dict[str, float],
    sources: dict[str, str] | None = None,
) -> tuple[str, float, float, str]:
    if not candidates:
        return "UNKNOWN", 0.0, 0.0, "no_overlap"

    ranked = sorted(candidates.items(), key=lambda item: item[1], reverse=True)
    top_speaker, top_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    margin = clamp01(top_score - second_score)
    if top_score <= 0:
        return "UNKNOWN", 0.0, 0.0, "no_overlap"
    source = (sources or {}).get(top_speaker, "diarization_overlap")
    return top_speaker, top_score, margin, source


def enrich_word(
    word: dict[str, Any],
    diarization_segments: list[dict[str, Any]],
    *,
    padding_sec: float = DEFAULT_PADDING_SEC,
) -> dict[str, Any]:
    enriched = dict(word)
    candidates, candidate_sources = score_word_candidates(
        word, diarization_segments, padding_sec=padding_sec
    )
    speaker, score, margin, source = pick_assignment(candidates, candidate_sources)
    flags = list(enriched.get("flags") or [])

    enriched["speaker"] = speaker
    enriched["speakerAssignmentScore"] = round(score, 4)
    enriched["speakerAssignmentMargin"] = round(margin, 4)
    enriched["speakerConfidence"] = enriched["speakerAssignmentScore"]
    enriched["speakerMargin"] = enriched["speakerAssignmentMargin"]
    enriched["speakerCandidates"] = {k: round(v, 4) for k, v in candidates.items()}
    enriched["speakerSource"] = source

    if source == "no_overlap":
        if "no_diarization_overlap" not in flags:
            flags.append("no_diarization_overlap")
    elif source == "diarization_nearby":
        if "diarization_nearby" not in flags:
            flags.append("diarization_nearby")
        if "low_assignment_score" not in flags:
            flags.append("low_assignment_score")
    elif score < LOW_ASSIGNMENT_SCORE or margin < LOW_ASSIGNMENT_MARGIN:
        if "low_assignment_score" not in flags:
            flags.append("low_assignment_score")

    if detect_overlap_possible(candidates):
        if "overlap_possible" not in flags:
            flags.append("overlap_possible")

    if flags:
        enriched["flags"] = flags
    return enriched


def assign_words_from_diarization(
    words: list[dict[str, Any]],
    diarization_segments: list[dict[str, Any]],
    *,
    padding_sec: float = DEFAULT_PADDING_SEC,
) -> list[dict[str, Any]]:
    return [
        enrich_word(word, diarization_segments, padding_sec=padding_sec)
        for word in words
    ]


def percent_unknown_words(words: list[dict[str, Any]]) -> float:
    if not words:
        return 0.0
    unknown = sum(1 for w in words if str(w.get("speaker") or "UNKNOWN") == "UNKNOWN")
    return unknown / len(words) * 100.0


def log_diarization_result(raw_result: Any) -> None:
    print(f"  Diarization result type: {type(raw_result)}")
    if hasattr(raw_result, "columns"):
        print(f"  Diarization columns: {list(raw_result.columns)}")
        print(f"  Diarization rows: {len(raw_result)}")
    elif hasattr(raw_result, "itertracks"):
        print("  Diarization result supports itertracks()")


def log_serialized_diarization(segments: list[dict[str, Any]]) -> None:
    print(f"  Serialized diarization segments: {len(segments)}")
    if segments:
        print(f"  First diarization segments: {segments[:3]}")


def _append_diarization_segment(
    segments: list[dict[str, Any]],
    start: Any,
    end: Any,
    speaker: Any,
) -> bool:
    if start is None or end is None or speaker is None:
        return False
    start_f = float(start)
    end_f = float(end)
    if end_f <= start_f:
        return False
    segments.append(
        {
            "startTime": round(start_f, 3),
            "endTime": round(end_f, 3),
            "speaker": str(speaker),
            "source": "pyannote",
        }
    )
    return True


def serialize_diarization_segments(raw_segments: Any) -> list[dict[str, Any]]:
    """Convert pyannote/whisperx diarization output to canonical JSON segments."""
    segments: list[dict[str, Any]] = []

    if raw_segments is None:
        return segments

    if hasattr(raw_segments, "iterrows"):
        for _, row in raw_segments.iterrows():
            _append_diarization_segment(
                segments,
                row.get("start", row.get("startTime")),
                row.get("end", row.get("endTime")),
                row.get("speaker", row.get("label")),
            )
    elif hasattr(raw_segments, "itertracks"):
        for turn, _, speaker in raw_segments.itertracks(yield_label=True):
            _append_diarization_segment(segments, turn.start, turn.end, speaker)
    elif isinstance(raw_segments, list):
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            _append_diarization_segment(
                segments,
                item.get("start", item.get("startTime")),
                item.get("end", item.get("endTime")),
                item.get("speaker") or item.get("label"),
            )
    else:
        raise TypeError(f"Unsupported diarization result type: {type(raw_segments)!r}")

    segments.sort(key=lambda seg: float(seg["startTime"]))
    return segments
