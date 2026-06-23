"""Episode-level diagnostics and manifest fields for transcript v2."""

from __future__ import annotations

from typing import Any

from row_builder import compute_display_diagnostics, verify_row_word_integrity
from speaker_assignment import percent_unknown_words


def build_episode_diagnostics(
    *,
    raw_segments: list[dict[str, Any]],
    diarization_segments: list[dict[str, Any]],
    word_segments: list[dict[str, Any]],
    speech_turns: list[dict[str, Any]],
    display_segments: list[dict[str, Any]],
    duration_seconds: float,
    diarized: bool,
    speaker_analysis: dict[str, Any] | None,
    turn_counters: dict[str, int] | None,
    vad_mismatch_count: int,
    missing_word_timestamps: int,
    turn_source: str,
    row_settings: dict[str, Any] | None,
    pipeline_timing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    integrity = verify_row_word_integrity(display_segments, word_segments)
    display_diag = compute_display_diagnostics(
        display_segments,
        word_segments,
        diarized=diarized,
        row_settings=row_settings,
    )

    word_count = len(word_segments)
    unknown_word_percent = round(percent_unknown_words(word_segments), 1) if diarized else 0.0
    diagnostics: dict[str, Any] = {
        "wordCount": word_count,
        "segmentCount": len(display_segments),
        "speechTurnCount": len(speech_turns),
        "rawSegmentCount": len(raw_segments),
        "diarizationSegmentCount": len(diarization_segments),
        "unknownWordPercent": unknown_word_percent,
        "missingWordTimestamps": missing_word_timestamps,
        "durationSeconds": round(duration_seconds, 3),
        "turnSource": turn_source,
        "vadWordMismatchCount": vad_mismatch_count,
        "vadWordMismatchPercent": round(vad_mismatch_count / max(word_count, 1) * 100.0, 2),
        "rowWordIntegrityPercent": integrity["rowWordIntegrityPercent"],
        "rowWordIntegrityOk": integrity["ok"],
    }
    diagnostics.update(display_diag)

    if turn_counters:
        diagnostics.update(turn_counters)

    if speaker_analysis:
        diagnostics.update(
            {
                "detectedSpeakerCount": speaker_analysis.get("detectedSpeakerCount"),
                "credibleSpeakerCount": speaker_analysis.get("credibleSpeakerCount"),
                "mainSpeakerCount": speaker_analysis.get("mainSpeakerCount"),
                "secondarySpeakerCount": speaker_analysis.get("secondarySpeakerCount"),
                "cameoSpeakerCount": speaker_analysis.get("cameoSpeakerCount"),
                "glitchSpeakerCount": speaker_analysis.get("glitchSpeakerCount"),
                "fragmentSpeakerCount": speaker_analysis.get("fragmentSpeakerCount"),
                "diarizationPattern": speaker_analysis.get("diarizationPattern"),
                "speakerChangesPerMinute": speaker_analysis.get("speakerChangesPerMinute"),
                "microTurnPercent": speaker_analysis.get("microTurnPercent"),
                "medianTurnSeconds": speaker_analysis.get("medianTurnSeconds"),
                "lowConfidenceWordPercent": speaker_analysis.get("lowConfidenceWordPercent"),
                "overlapPossibleWordPercent": speaker_analysis.get("overlapPossibleWordPercent"),
                "diarizationStability": speaker_analysis.get("diarizationStability"),
                "recommendedPreset": speaker_analysis.get("recommendedPreset"),
            }
        )

    quality_flags = list(diagnostics.get("qualityFlags") or [])
    if turn_source == "legacy_word_speakers":
        if "legacy_speaker_source" not in quality_flags:
            quality_flags.append("legacy_speaker_source")
    if diarized and unknown_word_percent > 50.0:
        quality_flags.append("high_unknown_word_percent")
    if vad_mismatch_count > 0 and word_count:
        pct = vad_mismatch_count / word_count * 100.0
        if pct > 5.0 and "high_vad_word_mismatch" not in quality_flags:
            quality_flags.append("high_vad_word_mismatch")
    if not integrity["ok"] and "row_word_integrity_failed" not in quality_flags:
        quality_flags.append("row_word_integrity_failed")
    if speaker_analysis:
        if speaker_analysis.get("detectedSpeakerCount", 0) > 8:
            quality_flags.append("high_detected_speaker_count")
        if speaker_analysis.get("diarizationPattern") == "overclustered_two_host":
            quality_flags.append("overclustered_two_host")
        if speaker_analysis.get("fragmentSpeakerCount", 0) >= 3:
            quality_flags.append("high_fragment_speaker_count")
        display_single_word_pct = diagnostics.get("singleWordSegmentPercent")
        if display_single_word_pct is not None and display_single_word_pct > 20.0:
            quality_flags.append("row_fragmentation_failure")
        if diagnostics.get("badSingleWordSegmentPercent", 0) > 5.0:
            quality_flags.append("bad_single_word_rows")
        if speaker_analysis.get("microTurnPercent", 0) > 20:
            quality_flags.append("high_micro_turn_percent")
        if speaker_analysis.get("speakerChangesPerMinute", 0) > 18:
            quality_flags.append("high_speaker_changes_per_minute")
        if speaker_analysis.get("diarizationStability") == "poor":
            quality_flags.append("low_diarization_stability")
        if speaker_analysis.get("lowConfidenceWordPercent", 0) > 8:
            quality_flags.append("high_low_confidence_word_percent")
        if speaker_analysis.get("overlapPossibleWordPercent", 0) > 5:
            quality_flags.append("high_overlap_possible_percent")
    if missing_word_timestamps and word_count:
        missing_pct = missing_word_timestamps / word_count * 100.0
        if missing_pct > 2.0:
            quality_flags.append("high_word_timing_missing_percent")
    if diagnostics.get("maxRowWordCount", 0) > 56:
        quality_flags.append("high_suspicious_long_rows")
    if speaker_analysis and speaker_analysis.get("diarizationStability") == "poor":
        quality_flags.append("needs_manual_review")

    diagnostics["qualityFlags"] = sorted(set(quality_flags))
    if speaker_analysis:
        diagnostics["speakerCount"] = speaker_analysis.get("detectedSpeakerCount")
    elif diarized:
        speakers = {str(w.get("speaker")) for w in word_segments if w.get("speaker")}
        diagnostics["speakerCount"] = len(speakers)
    if pipeline_timing is not None:
        diagnostics["pipelineTiming"] = pipeline_timing
    return diagnostics


def manifest_fields_from_diagnostics(diagnostics: dict[str, Any]) -> dict[str, Any]:
    return {
        "speechTurnCount": diagnostics.get("speechTurnCount"),
        "detectedSpeakerCount": diagnostics.get("detectedSpeakerCount"),
        "credibleSpeakerCount": diagnostics.get("credibleSpeakerCount"),
        "mainSpeakerCount": diagnostics.get("mainSpeakerCount"),
        "secondarySpeakerCount": diagnostics.get("secondarySpeakerCount"),
        "cameoSpeakerCount": diagnostics.get("cameoSpeakerCount"),
        "glitchSpeakerCount": diagnostics.get("glitchSpeakerCount"),
        "fragmentSpeakerCount": diagnostics.get("fragmentSpeakerCount"),
        "diarizationPattern": diagnostics.get("diarizationPattern"),
        "speakerChangesPerMinute": diagnostics.get("speakerChangesPerMinute"),
        "microTurnPercent": diagnostics.get("microTurnPercent"),
        "lowConfidenceWordPercent": diagnostics.get("lowConfidenceWordPercent"),
        "overlapPossibleWordPercent": diagnostics.get("overlapPossibleWordPercent"),
        "diarizationStability": diagnostics.get("diarizationStability"),
        "recommendedPreset": diagnostics.get("recommendedPreset"),
        "turnSource": diagnostics.get("turnSource"),
    }


def write_qa_report(manifest_path: Any, output_path: Any) -> None:
    import json
    from pathlib import Path

    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    items = manifest.get("items", [])
    report = {
        "generatedAt": manifest.get("generatedAt"),
        "episodeCount": len(items),
        "flagged": [
            item for item in items
            if item.get("qualityFlags") or item.get("diarizationStability") in {"poor", "fair", "legacy"}
        ],
        "items": items,
    }
    Path(output_path).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
