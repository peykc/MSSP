"""Build canonical speechTurns[] from wordSegments with speaker smoothing."""

from __future__ import annotations

import re
from typing import Any

from presets import PRESET_CHAOTIC, SmoothingPreset, get_preset
from row_builder import join_row_body

UNCERTAIN_MARGIN_THRESHOLD = 0.15
AMBIGUOUS_SPAN_MAX_WORDS = 4
HIGH_CONFIDENCE_MARGIN = 0.15
SHORT_INTERJECTION_MAX_DURATION_SEC = 1.5
SHORT_INTERJECTION_MAX_WORDS = 4
SHORT_INTERJECTIONS = frozenset({
    "yes", "no", "okay", "yeah", "right", "ok", "yep", "nah", "sure", "what", "huh",
})
PROTECTED_STANDALONE_INTERJECTIONS = SHORT_INTERJECTIONS | frozenset({"hello", "good"})
ORPHAN_BOUNDARY_MAX_WORDS = 2
ORPHAN_ABSORB_LEFT_GAP_SEC = 0.25
ORPHAN_ABSORB_RIGHT_GAP_SEC = 0.45
SENTENCE_PREFIX_REATTACH_MAX_GAP_SEC = 0.60
SENTENCE_PREFIX_MIN_FOLLOWING_WORDS = 2
PROTECTED_INTERJECTION_MIN_LEFT_GAP_SEC = 0.45


def word_duration(word: dict[str, Any]) -> float:
    start = word.get("startTime")
    end = word.get("endTime")
    if start is None or end is None:
        return 0.0
    return max(0.0, float(end) - float(start))


def word_gap(prev: dict[str, Any], nxt: dict[str, Any]) -> float:
    prev_end = prev.get("endTime")
    next_start = nxt.get("startTime")
    if prev_end is None or next_start is None:
        return 0.0
    return float(next_start) - float(prev_end)


def assignment_score(word: dict[str, Any]) -> float:
    return float(word.get("speakerAssignmentScore", word.get("speakerConfidence", 0.0)) or 0.0)


def assignment_margin(word: dict[str, Any]) -> float:
    return float(word.get("speakerAssignmentMargin", word.get("speakerMargin", 0.0)) or 0.0)


def normalize_word_body(word: dict[str, Any]) -> str:
    body = str(word.get("body") or "").strip().lower()
    return body.rstrip(".,!?;:")


def word_flags(word: dict[str, Any]) -> list[str]:
    return list(word.get("flags") or [])


def is_uncertain_assignment(word: dict[str, Any]) -> bool:
    if "overlap_possible" in word_flags(word):
        return True
    return assignment_margin(word) < UNCERTAIN_MARGIN_THRESHOLD


def has_competing_candidates(word: dict[str, Any]) -> bool:
    candidates = word.get("speakerCandidates") or {}
    if len(candidates) < 2:
        return False
    ranked = sorted(float(v) for v in candidates.values() if v is not None)
    if len(ranked) < 2:
        return False
    return ranked[-2] >= 0.25


def is_short_interjection_word(word: dict[str, Any]) -> bool:
    body = normalize_word_body(word)
    if not body or len(body) > 12:
        return False
    return body in SHORT_INTERJECTIONS


def is_ambiguous_word(word: dict[str, Any]) -> bool:
    return is_uncertain_assignment(word)


def is_high_confidence_anchor(word: dict[str, Any]) -> bool:
    if is_ambiguous_word(word):
        return False
    return assignment_margin(word) >= HIGH_CONFIDENCE_MARGIN


def ends_sentence(body: str) -> bool:
    return bool(re.search(r'[.!?]["\']?\s*$', str(body or "").strip()))


def is_standalone_interjection_phrase(words: list[dict[str, Any]]) -> bool:
    if not words or len(words) > SHORT_INTERJECTION_MAX_WORDS:
        return False
    if turn_span_duration(words) > SHORT_INTERJECTION_MAX_DURATION_SEC:
        return False
    if len(words) == 1:
        return is_short_interjection_word(words[0])
    return False


def find_contiguous_ambiguous_spans(
    words: list[dict[str, Any]],
    *,
    max_words: int = AMBIGUOUS_SPAN_MAX_WORDS,
) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    index = 0
    while index < len(words):
        if not is_ambiguous_word(words[index]):
            index += 1
            continue
        start = index
        while (
            index < len(words)
            and is_ambiguous_word(words[index])
            and (index - start) < max_words
        ):
            index += 1
        spans.append((start, index))
    return spans


def nearest_high_confidence_anchor_before(
    words: list[dict[str, Any]],
    start_index: int,
    *,
    max_lookback: int = 40,
) -> dict[str, Any] | None:
    for index in range(start_index - 1, max(-1, start_index - max_lookback - 1), -1):
        if is_high_confidence_anchor(words[index]):
            return words[index]
    return None


def nearest_high_confidence_anchor_after(
    words: list[dict[str, Any]],
    end_index: int,
    *,
    max_lookahead: int = 40,
) -> dict[str, Any] | None:
    for index in range(end_index, min(len(words), end_index + max_lookahead)):
        if is_high_confidence_anchor(words[index]):
            return words[index]
    return None


def assign_span_speaker(
    span_words: list[dict[str, Any]],
    speaker: str,
    reason: str,
) -> None:
    for word in span_words:
        word["speaker"] = speaker
        flags = list(word.get("flags") or [])
        for flag in (reason, "ambiguous_span_resolved"):
            if flag not in flags:
                flags.append(flag)
        word["flags"] = flags


def mark_span_unresolved(span_words: list[dict[str, Any]]) -> None:
    for word in span_words:
        flags = list(word.get("flags") or [])
        if "ambiguous_span_unresolved" not in flags:
            flags.append("ambiguous_span_unresolved")
        word["flags"] = flags


def resolve_ambiguous_spans(
    words: list[dict[str, Any]],
    preset: SmoothingPreset,
) -> tuple[list[dict[str, Any]], int]:
    if not words:
        return [], 0

    resolved = [dict(w) for w in words]
    resolved_count = 0

    for start, end in find_contiguous_ambiguous_spans(resolved):
        span = resolved[start:end]
        if is_standalone_interjection_phrase(span):
            continue

        prev_word = resolved[start - 1] if start > 0 else None
        prev_anchor = nearest_high_confidence_anchor_before(resolved, start)
        next_anchor = nearest_high_confidence_anchor_after(resolved, end)

        if prev_word and ends_sentence(str(prev_word.get("body") or "")) and next_anchor:
            assign_span_speaker(span, str(next_anchor["speaker"]), "ambiguous_prefix_to_next_sentence")
            resolved_count += 1
            continue

        if prev_anchor and (prev_word is None or not ends_sentence(str(prev_word.get("body") or ""))):
            assign_span_speaker(span, str(prev_anchor["speaker"]), "ambiguous_continuation")
            resolved_count += 1
            continue

        if next_anchor:
            assign_span_speaker(span, str(next_anchor["speaker"]), "ambiguous_prefix_to_next_sentence")
            resolved_count += 1
            continue

        mark_span_unresolved(span)

    return resolved, resolved_count


def count_following_same_speaker_words(
    words: list[dict[str, Any]],
    start_index: int,
    speaker: str,
    *,
    max_words: int = 4,
) -> int:
    count = 0
    for index in range(start_index, min(len(words), start_index + max_words)):
        if str(words[index].get("speaker") or "") != speaker:
            break
        count += 1
    return count


def is_protected_standalone_interjection(
    span: list[dict[str, Any]],
    left_gap: float,
    right_gap: float,
) -> bool:
    if not is_standalone_interjection_phrase(span):
        return False
    body = normalize_word_body(span[0])
    if body not in PROTECTED_STANDALONE_INTERJECTIONS:
        return False
    return left_gap >= PROTECTED_INTERJECTION_MIN_LEFT_GAP_SEC


def append_word_flag(word: dict[str, Any], flag: str) -> None:
    flags = list(word.get("flags") or [])
    if flag not in flags:
        flags.append(flag)
    word["flags"] = flags


def repair_orphan_boundary_tokens(
    words: list[dict[str, Any]],
    preset: SmoothingPreset,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if not words:
        return [], {
            "orphanBoundaryTokenAbsorbedCount": 0,
            "sentencePrefixReattachedCount": 0,
        }

    repaired = [dict(w) for w in words]
    absorbed_count = 0
    reattached_count = 0
    index = 0

    while index < len(repaired):
        repaired_here = False

        for span_len in range(ORPHAN_BOUNDARY_MAX_WORDS, 0, -1):
            if index + span_len > len(repaired):
                continue

            span = repaired[index : index + span_len]
            span_speaker = str(span[0].get("speaker") or "")
            if not span_speaker or any(str(w.get("speaker") or "") != span_speaker for w in span):
                continue

            prev_word = repaired[index - 1] if index > 0 else None
            next_word = repaired[index + span_len] if index + span_len < len(repaired) else None
            if not prev_word or not next_word:
                continue

            prev_speaker = str(prev_word.get("speaker") or "")
            next_speaker = str(next_word.get("speaker") or "")
            left_gap = word_gap(prev_word, span[0])
            right_gap = word_gap(span[-1], next_word)
            span_ends_sentence = ends_sentence(str(span[-1].get("body") or ""))
            prev_ends_sentence = ends_sentence(str(prev_word.get("body") or ""))

            if (
                prev_speaker
                and prev_speaker == next_speaker
                and span_speaker != prev_speaker
                and not is_protected_standalone_interjection(span, left_gap, right_gap)
                and (
                    left_gap <= ORPHAN_ABSORB_LEFT_GAP_SEC
                    or right_gap <= ORPHAN_ABSORB_RIGHT_GAP_SEC
                    or not prev_ends_sentence
                )
            ):
                for word in span:
                    word["speaker"] = prev_speaker
                    append_word_flag(word, "orphan_boundary_token_absorbed")
                absorbed_count += len(span)
                index += span_len
                repaired_here = True
                break

            next_run_len = count_following_same_speaker_words(
                repaired,
                index + span_len,
                next_speaker,
                max_words=4,
            )
            if (
                prev_ends_sentence
                and not span_ends_sentence
                and span_speaker != next_speaker
                and next_run_len >= SENTENCE_PREFIX_MIN_FOLLOWING_WORDS
                and right_gap <= SENTENCE_PREFIX_REATTACH_MAX_GAP_SEC
            ):
                for word in span:
                    word["speaker"] = next_speaker
                    append_word_flag(word, "sentence_prefix_reattached")
                reattached_count += len(span)
                index += span_len
                repaired_here = True
                break

        if not repaired_here:
            index += 1

    return repaired, {
        "orphanBoundaryTokenAbsorbedCount": absorbed_count,
        "sentencePrefixReattachedCount": reattached_count,
    }


def should_isolate_uncertain_interjection(word: dict[str, Any]) -> bool:
    if not is_standalone_interjection_phrase([word]):
        return False
    return is_ambiguous_word(word) and has_competing_candidates(word)


def turn_has_uncertain_words(words: list[dict[str, Any]]) -> bool:
    return any(is_uncertain_assignment(w) for w in words)


def is_low_confidence(word: dict[str, Any], preset: SmoothingPreset) -> bool:
    if is_uncertain_assignment(word):
        return True
    return (
        assignment_score(word) < preset.low_assignment_score
        or assignment_margin(word) < preset.low_assignment_margin
    )


def turn_span_duration(words: list[dict[str, Any]]) -> float:
    if not words:
        return 0.0
    start = words[0].get("startTime")
    end = words[-1].get("endTime")
    if start is None or end is None:
        return sum(word_duration(w) for w in words)
    return max(0.0, float(end) - float(start))


def island_can_absorb(
    span: list[dict[str, Any]],
    prev_sp: str,
    next_sp: str,
    speaker_classes: dict[str, str],
    preset: SmoothingPreset,
) -> bool:
    if not span or prev_sp != next_sp:
        return False
    island_sp = span[0].get("speaker")
    if not island_sp or island_sp == prev_sp:
        return False
    if not all(w.get("speaker") == island_sp for w in span):
        return False
    if len(span) > preset.micro_flip_absorb_max_words:
        return False
    if turn_span_duration(span) > preset.micro_flip_absorb_max_duration_sec:
        return False
    if not all(is_low_confidence(w, preset) for w in span):
        return False
    if any(is_uncertain_assignment(w) for w in span):
        return False
    if speaker_classes.get(str(island_sp)) in {"cameo", "secondary", "main"}:
        return False
    return True


def absorb_island(span: list[dict[str, Any]], target_speaker: str) -> None:
    for word in span:
        word["speaker"] = target_speaker
        flags = list(word.get("flags") or [])
        if "speaker_glitch_absorbed" not in flags:
            flags.append("speaker_glitch_absorbed")
        word["flags"] = flags


def smooth_speaker_flips(
    words: list[dict[str, Any]],
    speaker_classes: dict[str, str],
    preset: SmoothingPreset,
    *,
    legacy: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    if legacy or len(words) < 3:
        return [dict(w) for w in words], 0

    smoothed = [dict(w) for w in words]
    absorbed = 0
    max_span = max(1, preset.micro_flip_absorb_max_words)
    i = 1

    while i < len(smoothed) - 1:
        prev_sp = str(smoothed[i - 1].get("speaker") or "")
        if not prev_sp:
            i += 1
            continue

        absorbed_here = False
        for span_len in range(max_span, 0, -1):
            end_idx = i + span_len - 1
            if end_idx >= len(smoothed) - 1:
                continue
            next_sp = str(smoothed[end_idx + 1].get("speaker") or "")
            span = smoothed[i : end_idx + 1]
            if island_can_absorb(span, prev_sp, next_sp, speaker_classes, preset):
                absorb_island(span, prev_sp)
                absorbed += len(span)
                i = end_idx + 1
                absorbed_here = True
                break

        if not absorbed_here:
            i += 1

    return smoothed, absorbed


def is_short_interjection_candidate(words: list[dict[str, Any]]) -> bool:
    if not words:
        return False
    duration = turn_span_duration(words)
    return duration < SHORT_INTERJECTION_MAX_DURATION_SEC or len(words) <= SHORT_INTERJECTION_MAX_WORDS


def should_preserve_interjection(
    words: list[dict[str, Any]],
    speaker_classes: dict[str, str],
    preset: SmoothingPreset,
) -> bool:
    if not is_short_interjection_candidate(words):
        return False

    speaker = str(words[0].get("speaker") or "UNKNOWN")
    cls = speaker_classes.get(speaker, "")
    duration = turn_span_duration(words)

    if cls in {"cameo", "secondary"}:
        return True
    if cls == "main" and len(words) <= 2 and duration < preset.interjection_preserve_min_duration_sec:
        return assignment_margin(words[0]) >= preset.low_assignment_margin + 0.15
    return False


def should_split_turn_at_word(
    word: dict[str, Any],
    current_turn: list[dict[str, Any]],
) -> bool:
    if not is_standalone_interjection_phrase([word]):
        return False
    return should_isolate_uncertain_interjection(word) or "ambiguous_span_unresolved" in word_flags(word)


def is_uncertain_interjection_turn(turn_words: list[dict[str, Any]]) -> bool:
    return is_standalone_interjection_phrase(turn_words) and (
        should_isolate_uncertain_interjection(turn_words[0])
        or any("ambiguous_span_unresolved" in word_flags(w) for w in turn_words)
    )


def turn_record_flags(turn_words: list[dict[str, Any]], avg_score: float) -> list[str]:
    turn_flags: list[str] = []
    if is_uncertain_interjection_turn(turn_words):
        for flag in ("uncertain_interjection", "overlap_possible"):
            if flag not in turn_flags:
                turn_flags.append(flag)
        return turn_flags

    span_flags = {flag for word in turn_words for flag in word_flags(word)}
    if span_flags.intersection({"ambiguous_prefix_to_next_sentence", "ambiguous_continuation"}):
        if "low_confidence_prefix" not in turn_flags:
            turn_flags.append("low_confidence_prefix")
    if span_flags.intersection({"sentence_prefix_reattached", "orphan_boundary_token_absorbed"}):
        if "boundary_token_repaired" not in turn_flags:
            turn_flags.append("boundary_token_repaired")
    if "overlap_possible" in span_flags or turn_has_uncertain_words(turn_words):
        if "overlap_possible" not in turn_flags:
            turn_flags.append("overlap_possible")
    if turn_has_uncertain_words(turn_words) and "low_speaker_confidence" not in turn_flags:
        turn_flags.append("low_speaker_confidence")
    if avg_score < 0.55 and "low_speaker_confidence" not in turn_flags:
        turn_flags.append("low_speaker_confidence")
    return turn_flags


def group_words_into_turns(
    words: list[dict[str, Any]],
    preset: SmoothingPreset,
) -> list[list[dict[str, Any]]]:
    if not words:
        return []
    turns: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = [dict(words[0])]
    for word in words[1:]:
        w = dict(word)
        prev = current[-1]
        speaker_changed = w.get("speaker") != prev.get("speaker")
        gap = word_gap(prev, w)
        if speaker_changed or should_split_turn_at_word(w, current):
            turns.append(current)
            current = [w]
        elif gap > preset.turn_gap_split_sec:
            turns.append(current)
            current = [w]
        else:
            current.append(w)
    if current:
        turns.append(current)
    return turns


def stitch_same_speaker_fragments(
    turn_groups: list[list[dict[str, Any]]],
    preset: SmoothingPreset,
) -> tuple[list[list[dict[str, Any]]], int]:
    if len(turn_groups) < 2:
        return turn_groups, 0

    stitched: list[list[dict[str, Any]]] = [list(turn_groups[0])]
    stitch_count = 0

    for group in turn_groups[1:]:
        prev = stitched[-1]
        if not prev or not group:
            stitched.append(list(group))
            continue
        same_speaker = prev[-1].get("speaker") == group[0].get("speaker")
        gap = word_gap(prev[-1], group[0])
        uncertain_boundary = (
            is_standalone_interjection_phrase(group)
            and (
                should_isolate_uncertain_interjection(group[0])
                or "ambiguous_span_unresolved" in word_flags(group[0])
            )
        )
        if same_speaker and gap <= preset.same_speaker_stitch_gap_sec and not uncertain_boundary:
            prev.extend(dict(w) for w in group)
            flags = list(prev[-1].get("flags") or [])
            if "stitched_same_speaker" not in flags:
                flags.append("stitched_same_speaker")
            prev[-1]["flags"] = flags
            stitch_count += 1
        else:
            stitched.append(list(group))
    return stitched, stitch_count


def build_turn_record(
    turn_id: int,
    turn_words: list[dict[str, Any]],
    speaker_classes: dict[str, str],
    *,
    source: str = "full_pipeline",
    flags: list[str] | None = None,
) -> dict[str, Any]:
    speaker = str(turn_words[0].get("speaker") or "UNKNOWN")
    scores = [assignment_score(w) for w in turn_words]
    margins = [assignment_margin(w) for w in turn_words]
    avg_score = sum(scores) / len(scores) if scores else 0.0
    avg_margin = sum(margins) / len(margins) if margins else 0.0
    start = turn_words[0].get("startTime")
    end = turn_words[-1].get("endTime")
    duration = 0.0
    if start is not None and end is not None:
        duration = max(0.0, float(end) - float(start))

    turn_flags = list(flags or [])
    turn_flags.extend(
        flag for flag in turn_record_flags(turn_words, avg_score) if flag not in turn_flags
    )
    if duration >= 30.0:
        turn_flags.append("long_turn")
    if len(turn_words) <= 2 and duration < 1.0:
        turn_flags.append("short_cameo")

    return {
        "turnId": turn_id,
        "speaker": speaker,
        "speakerClass": speaker_classes.get(speaker, "unknown_or_overlap"),
        "startTime": start,
        "endTime": end,
        "body": join_row_body(turn_words),
        "words": [dict(w) for w in turn_words],
        "wordCount": len(turn_words),
        "durationSeconds": round(duration, 3),
        "confidence": round(avg_score, 4),
        "speakerMargin": round(avg_margin, 4),
        "source": source,
        "flags": turn_flags,
    }


def build_speech_turns(
    words: list[dict[str, Any]],
    speaker_analysis: dict[str, Any],
    preset: SmoothingPreset | None = None,
    *,
    turn_source: str = "full_pipeline",
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if not words:
        return [], {
            "absorbedMicroFlipCount": 0,
            "preservedInterjectionCount": 0,
            "sameSpeakerStitchCandidateCount": 0,
            "uncertainInterjectionTurnCount": 0,
            "resolvedAmbiguousSpanCount": 0,
            "orphanBoundaryTokenAbsorbedCount": 0,
            "sentencePrefixReattachedCount": 0,
        }

    preset = preset or get_preset(speaker_analysis.get("recommendedPreset", PRESET_CHAOTIC))
    speaker_classes = speaker_analysis.get("speakerClasses", {})
    legacy = turn_source == "legacy_word_speakers"

    smoothed, absorbed = smooth_speaker_flips(words, speaker_classes, preset, legacy=legacy)
    resolved, resolved_spans = resolve_ambiguous_spans(smoothed, preset)
    repaired, repair_counters = repair_orphan_boundary_tokens(resolved, preset)
    turn_groups = group_words_into_turns(repaired, preset)
    turn_groups, stitch_count = stitch_same_speaker_fragments(turn_groups, preset)

    preserved = 0
    speech_turns: list[dict[str, Any]] = []
    for turn_id, group in enumerate(turn_groups):
        if should_preserve_interjection(group, speaker_classes, preset):
            preserved += 1
        speech_turns.append(
            build_turn_record(
                turn_id,
                group,
                speaker_classes,
                source=turn_source,
            )
        )

    counters = {
        "absorbedMicroFlipCount": absorbed,
        "preservedInterjectionCount": preserved,
        "sameSpeakerStitchCandidateCount": stitch_count,
        "uncertainInterjectionTurnCount": sum(
            1 for group in turn_groups if is_uncertain_interjection_turn(group)
        ),
        "resolvedAmbiguousSpanCount": resolved_spans,
        "orphanBoundaryTokenAbsorbedCount": repair_counters["orphanBoundaryTokenAbsorbedCount"],
        "sentencePrefixReattachedCount": repair_counters["sentencePrefixReattachedCount"],
    }
    return speech_turns, counters
