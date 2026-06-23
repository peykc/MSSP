"""Per-speaker stats, classification, and adaptive preset recommendation."""

from __future__ import annotations

import statistics
from typing import Any

from presets import PRESET_CHAOTIC, PRESET_GROUP, PRESET_NORMAL, SmoothingPreset, get_preset, preset_to_dict

SPEAKER_CLASS_MAIN = "main"
SPEAKER_CLASS_SECONDARY = "secondary"
SPEAKER_CLASS_CAMEO = "cameo"
SPEAKER_CLASS_FRAGMENT = "fragment"
SPEAKER_CLASS_GLITCH = "glitch"
SPEAKER_CLASS_UNKNOWN = "unknown_or_overlap"

CREDIBLE_WORD_SHARE_MIN = 5.0
CREDIBLE_SPEECH_SECONDS_MIN = 90.0
OVERCLUSTERED_TOP_TWO_SHARE_MIN = 70.0
OVERCLUSTERED_MIN_DETECTED_SPEAKERS = 6


def _word_duration(word: dict[str, Any]) -> float:
    start = word.get("startTime")
    end = word.get("endTime")
    if start is None or end is None:
        return 0.0
    return max(0.0, float(end) - float(start))


def _assignment_score(word: dict[str, Any]) -> float:
    return float(word.get("speakerAssignmentScore", word.get("speakerConfidence", 0.0)) or 0.0)


def _assignment_margin(word: dict[str, Any]) -> float:
    return float(word.get("speakerAssignmentMargin", word.get("speakerMargin", 0.0)) or 0.0)


def group_words_by_speaker(words: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for word in words:
        speaker = str(word.get("speaker") or "UNKNOWN")
        grouped.setdefault(speaker, []).append(word)
    return grouped


def compute_turn_boundaries(words: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    if not words:
        return []
    turns: list[tuple[str, list[dict[str, Any]]]] = []
    current_speaker = str(words[0].get("speaker") or "UNKNOWN")
    current: list[dict[str, Any]] = []
    for word in words:
        speaker = str(word.get("speaker") or "UNKNOWN")
        if current and speaker != current_speaker:
            turns.append((current_speaker, current))
            current = []
            current_speaker = speaker
        current.append(word)
    if current:
        turns.append((current_speaker, current))
    return turns


def _episode_time_bounds(words: list[dict[str, Any]]) -> tuple[float, float]:
    if not words:
        return 0.0, 1.0
    starts = [float(w.get("startTime", 0)) for w in words if w.get("startTime") is not None]
    ends = [float(w.get("endTime", 0)) for w in words if w.get("endTime") is not None]
    if not starts or not ends:
        return 0.0, 1.0
    return min(starts), max(ends)


def _speaker_region_coverage(
    speaker_words: list[dict[str, Any]],
    episode_start: float,
    episode_end: float,
    *,
    region_count: int = 3,
) -> int:
    if not speaker_words:
        return 0
    span = max(episode_end - episode_start, 1.0)
    bucket_size = span / region_count
    buckets: set[int] = set()
    for word in speaker_words:
        start = word.get("startTime")
        if start is None:
            continue
        offset = float(start) - episode_start
        bucket = min(region_count - 1, int(offset / bucket_size))
        buckets.add(bucket)
    return len(buckets)


def _stable_presence(stat: dict[str, Any], region_coverage: int) -> bool:
    return (
        region_coverage >= 2
        and stat["turnCount"] >= 3
        and stat["cleanTurnCount"] > 0
    )


def _is_credible_speaker(stat: dict[str, Any], region_coverage: int) -> bool:
    word_pct = stat["percentOfEpisodeWords"]
    speech_sec = stat["totalSpeechSeconds"]
    if word_pct >= CREDIBLE_WORD_SHARE_MIN:
        return True
    if speech_sec >= CREDIBLE_SPEECH_SECONDS_MIN:
        return True
    return _stable_presence(stat, region_coverage)


def detect_overclustered_two_host(stats: dict[str, dict[str, Any]]) -> bool:
    if len(stats) < OVERCLUSTERED_MIN_DETECTED_SPEAKERS:
        return False
    ranked = sorted(
        stats.items(),
        key=lambda item: item[1]["percentOfEpisodeWords"],
        reverse=True,
    )
    if len(ranked) < 2:
        return False
    top_two_share = ranked[0][1]["percentOfEpisodeWords"] + ranked[1][1]["percentOfEpisodeWords"]
    if top_two_share < OVERCLUSTERED_TOP_TWO_SHARE_MIN:
        return False
    others = ranked[2:]
    if not others:
        return False
    return all(item[1]["percentOfEpisodeWords"] < 10.0 for item in others)


def compute_speaker_stats(
    words: list[dict[str, Any]],
    duration_seconds: float,
) -> dict[str, dict[str, Any]]:
    grouped = group_words_by_speaker(words)
    total_words = len(words) or 1
    total_speech = sum(_word_duration(w) for w in words) or 1.0
    global_turns = compute_turn_boundaries(words)

    per_speaker_turns: dict[str, list[list[dict[str, Any]]]] = {}
    for speaker, turn_words in global_turns:
        per_speaker_turns.setdefault(speaker, []).append(turn_words)

    episode_start, episode_end = _episode_time_bounds(words)
    stats: dict[str, dict[str, Any]] = {}

    for speaker, speaker_words in grouped.items():
        turns = per_speaker_turns.get(speaker, [])
        turn_durations = [
            max(0.0, float(t[-1].get("endTime", 0)) - float(t[0].get("startTime", 0)))
            for t in turns
            if t
        ]
        micro_turns = sum(1 for t in turns if len(t) <= 2)
        clean_turns = sum(1 for t in turns if len(t) >= 3)
        speech_seconds = sum(_word_duration(w) for w in speaker_words)
        region_coverage = _speaker_region_coverage(
            speaker_words,
            episode_start,
            episode_end,
        )

        stats[speaker] = {
            "speaker": speaker,
            "totalSpeechSeconds": round(speech_seconds, 3),
            "wordCount": len(speaker_words),
            "turnCount": len(turns),
            "medianTurnSeconds": round(statistics.median(turn_durations), 3) if turn_durations else 0.0,
            "longestTurnSeconds": round(max(turn_durations), 3) if turn_durations else 0.0,
            "percentOfEpisodeWords": round(len(speaker_words) / total_words * 100.0, 2),
            "percentOfEpisodeSpeech": round(speech_seconds / total_speech * 100.0, 2),
            "cleanTurnCount": clean_turns,
            "microTurnCount": micro_turns,
            "regionCoverage": region_coverage,
            "surroundedMicroFlipCount": 0,
        }
    return stats


def classify_speaker(stat: dict[str, Any], episode_word_count: int) -> str:
    speaker = stat["speaker"]
    if speaker == "UNKNOWN":
        return SPEAKER_CLASS_UNKNOWN

    word_pct = stat["percentOfEpisodeWords"]
    speech_sec = stat["totalSpeechSeconds"]
    micro_ratio = stat["microTurnCount"] / max(stat["turnCount"], 1)
    has_clean = stat["cleanTurnCount"] > 0
    region_coverage = stat.get("regionCoverage", 0)
    stable = _stable_presence(stat, region_coverage)

    if (
        stat["wordCount"] <= 4
        and speech_sec < 1.0
        and micro_ratio > 0.6
        and not has_clean
    ):
        return SPEAKER_CLASS_GLITCH
    if word_pct < 0.3 and stat["microTurnCount"] >= stat["turnCount"]:
        return SPEAKER_CLASS_GLITCH

    if word_pct >= 8.0 and has_clean and _is_credible_speaker(stat, region_coverage):
        return SPEAKER_CLASS_MAIN
    if word_pct >= CREDIBLE_WORD_SHARE_MIN and has_clean:
        return SPEAKER_CLASS_SECONDARY
    if stable and has_clean and word_pct >= 2.0:
        return SPEAKER_CLASS_SECONDARY
    if 1.0 <= word_pct < CREDIBLE_WORD_SHARE_MIN and has_clean and not stable:
        return SPEAKER_CLASS_FRAGMENT
    if word_pct >= 0.5 and (stat["wordCount"] >= 3 or speech_sec >= 0.7):
        return SPEAKER_CLASS_CAMEO
    return SPEAKER_CLASS_UNKNOWN


def analyze_speakers(
    words: list[dict[str, Any]],
    duration_seconds: float,
    *,
    speaker_mode: str = "adaptive",
    explicit_preset: str | None = None,
) -> dict[str, Any]:
    stats = compute_speaker_stats(words, duration_seconds)
    episode_word_count = len(words)

    classes: dict[str, str] = {}
    for speaker, stat in stats.items():
        classes[speaker] = classify_speaker(stat, episode_word_count)

    class_counts = {
        "main": sum(1 for c in classes.values() if c == SPEAKER_CLASS_MAIN),
        "secondary": sum(1 for c in classes.values() if c == SPEAKER_CLASS_SECONDARY),
        "cameo": sum(1 for c in classes.values() if c == SPEAKER_CLASS_CAMEO),
        "fragment": sum(1 for c in classes.values() if c == SPEAKER_CLASS_FRAGMENT),
        "glitch": sum(1 for c in classes.values() if c == SPEAKER_CLASS_GLITCH),
        "unknown_or_overlap": sum(1 for c in classes.values() if c == SPEAKER_CLASS_UNKNOWN),
    }

    credible = {
        sp for sp, stat in stats.items()
        if sp != "UNKNOWN" and _is_credible_speaker(stat, stat.get("regionCoverage", 0))
        and classes.get(sp) in {SPEAKER_CLASS_MAIN, SPEAKER_CLASS_SECONDARY}
    }

    overclustered_two_host = detect_overclustered_two_host(stats)
    diarization_pattern = "overclustered_two_host" if overclustered_two_host else None
    stabilize_smoothing = "aggressive" if overclustered_two_host else None

    turns = compute_turn_boundaries(words)
    micro_turns = sum(1 for _, t in turns if len(t) <= 2)
    micro_turn_pct = (micro_turns / len(turns) * 100.0) if turns else 0.0
    turn_durations = [
        max(0.0, float(t[-1].get("endTime", 0)) - float(t[0].get("startTime", 0)))
        for _, t in turns
        if t
    ]
    median_turn = statistics.median(turn_durations) if turn_durations else 0.0

    speaker_changes = sum(
        1 for i in range(1, len(words))
        if words[i].get("speaker") != words[i - 1].get("speaker")
    )
    minutes = max(duration_seconds / 60.0, 0.01)
    changes_per_min = speaker_changes / minutes

    low_conf = sum(1 for w in words if _assignment_score(w) < 0.55 or _assignment_margin(w) < 0.20)
    low_conf_pct = low_conf / max(episode_word_count, 1) * 100.0
    overlap_flags = sum(1 for w in words if "overlap_possible" in (w.get("flags") or []))
    overlap_pct = overlap_flags / max(episode_word_count, 1) * 100.0

    stability = "good"
    if changes_per_min > 20 or micro_turn_pct > 25 or low_conf_pct > 10:
        stability = "poor"
    elif changes_per_min > 12 or micro_turn_pct > 15 or low_conf_pct > 6:
        stability = "fair"

    if explicit_preset:
        recommended = explicit_preset
    elif speaker_mode == "normal":
        recommended = PRESET_NORMAL
    elif speaker_mode == "group":
        recommended = PRESET_GROUP
    elif speaker_mode == "chaotic":
        recommended = PRESET_CHAOTIC
    else:
        if overclustered_two_host:
            recommended = PRESET_NORMAL
        elif stability == "poor" or micro_turn_pct > 20:
            recommended = PRESET_CHAOTIC
        elif len(credible) >= 5:
            recommended = PRESET_GROUP
        else:
            recommended = PRESET_NORMAL

    return {
        "speakerStats": stats,
        "speakerClasses": classes,
        "detectedSpeakerCount": len(stats),
        "credibleSpeakerCount": len(credible),
        "mainSpeakerCount": class_counts["main"],
        "secondarySpeakerCount": class_counts["secondary"],
        "cameoSpeakerCount": class_counts["cameo"],
        "fragmentSpeakerCount": class_counts["fragment"],
        "glitchSpeakerCount": class_counts["glitch"],
        "speakerChangesPerMinute": round(changes_per_min, 2),
        "microTurnPercent": round(micro_turn_pct, 1),
        "medianTurnSeconds": round(float(median_turn), 3),
        "lowConfidenceWordPercent": round(low_conf_pct, 1),
        "overlapPossibleWordPercent": round(overlap_pct, 1),
        "diarizationStability": stability,
        "diarizationPattern": diarization_pattern,
        "stabilizeSmoothing": stabilize_smoothing,
        "recommendedPreset": recommended,
        "appliedPreset": preset_to_dict(get_preset(recommended)),
    }


def resolve_smoothing_preset(
    analysis: dict[str, Any],
    *,
    speaker_mode: str,
    explicit_preset: str | None = None,
    speaker_smoothing: str | None = None,
) -> SmoothingPreset:
    from presets import apply_smoothing_intensity

    if explicit_preset:
        base = get_preset(explicit_preset)
    elif speaker_mode in {"normal", "group", "chaotic"}:
        base = get_preset(speaker_mode)
    else:
        base = get_preset(analysis.get("recommendedPreset", PRESET_NORMAL))

    intensity = speaker_smoothing or analysis.get("stabilizeSmoothing")
    return apply_smoothing_intensity(base, intensity)
