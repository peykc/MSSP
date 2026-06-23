"""VAD region cache/export — advisory only; does not gate diarization or drop words."""

from __future__ import annotations

from typing import Any

DEFAULT_VAD_SETTINGS: dict[str, Any] = {
    "vad_filter": True,
    "vad_parameters": {
        "min_silence_duration_ms": 500,
    },
}


def default_vad_settings() -> dict[str, Any]:
    return dict(DEFAULT_VAD_SETTINGS)


def build_transcribe_vad_kwargs(vad_settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Kwargs passed into WhisperX model.transcribe.

    WhisperX's FasterWhisperPipeline.transcribe does not accept faster-whisper
    kwargs like vad_filter/vad_parameters in all installed versions. WhisperX
    handles its own VAD/chunking internally. For v2.0, vad.py exports/caches
    advisory VAD regions derived from ASR segments instead of forcing VAD kwargs.
    """
    return {}


def derive_regions_from_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Approximate speech regions from ASR segment boundaries (export/cache only)."""
    regions: list[dict[str, Any]] = []
    for segment in segments:
        start = segment.get("start")
        end = segment.get("end")
        if start is None or end is None:
            continue
        start_f = float(start)
        end_f = float(end)
        if end_f <= start_f:
            continue
        regions.append({"startTime": round(start_f, 3), "endTime": round(end_f, 3)})
    return regions


def word_in_region(word: dict[str, Any], region: dict[str, Any]) -> bool:
    ws = word.get("startTime")
    we = word.get("endTime")
    rs = region.get("startTime")
    re = region.get("endTime")
    if ws is None or we is None or rs is None or re is None:
        return False
    return float(we) > float(rs) and float(ws) < float(re)


def word_in_any_region(word: dict[str, Any], regions: list[dict[str, Any]]) -> bool:
    if not regions:
        return True
    return any(word_in_region(word, region) for region in regions)


def flag_vad_mismatches(
    words: list[dict[str, Any]],
    regions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    """Flag words outside VAD regions; never remove words."""
    if not regions:
        return [dict(w) for w in words], 0

    flagged: list[dict[str, Any]] = []
    mismatch_count = 0
    for raw in words:
        word = dict(raw)
        if not word_in_any_region(word, regions):
            flags = list(word.get("flags") or [])
            if "outside_vad_region" not in flags:
                flags.append("outside_vad_region")
            word["flags"] = flags
            mismatch_count += 1
        flagged.append(word)
    return flagged, mismatch_count


def build_vad_cache_payload(
    vad_settings: dict[str, Any],
    regions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "settings": vad_settings,
        "regions": regions,
        "regionCount": len(regions),
    }
