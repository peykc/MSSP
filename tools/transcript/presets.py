"""Speaker smoothing presets for turn building."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

PRESET_NORMAL = "normal"
PRESET_GROUP = "group"
PRESET_CHAOTIC = "chaotic"
PRESET_FORCED_TWO_HOST = "forced_two_host"

ADAPTIVE_PRESETS = frozenset({PRESET_NORMAL, PRESET_GROUP, PRESET_CHAOTIC})


@dataclass(frozen=True)
class SmoothingPreset:
    name: str
    micro_flip_absorb_max_duration_sec: float
    micro_flip_absorb_max_words: int
    interjection_preserve_min_duration_sec: float
    interjection_preserve_min_words: int
    same_speaker_stitch_gap_sec: float
    turn_gap_split_sec: float
    low_assignment_score: float
    low_assignment_margin: float
    overlap_flagging: str  # normal | aggressive


PRESETS: dict[str, SmoothingPreset] = {
    PRESET_NORMAL: SmoothingPreset(
        name=PRESET_NORMAL,
        micro_flip_absorb_max_duration_sec=0.50,
        micro_flip_absorb_max_words=2,
        interjection_preserve_min_duration_sec=0.70,
        interjection_preserve_min_words=3,
        same_speaker_stitch_gap_sec=1.00,
        turn_gap_split_sec=2.50,
        low_assignment_score=0.55,
        low_assignment_margin=0.20,
        overlap_flagging="normal",
    ),
    PRESET_GROUP: SmoothingPreset(
        name=PRESET_GROUP,
        micro_flip_absorb_max_duration_sec=0.45,
        micro_flip_absorb_max_words=2,
        interjection_preserve_min_duration_sec=0.65,
        interjection_preserve_min_words=3,
        same_speaker_stitch_gap_sec=1.00,
        turn_gap_split_sec=2.50,
        low_assignment_score=0.55,
        low_assignment_margin=0.20,
        overlap_flagging="normal",
    ),
    PRESET_CHAOTIC: SmoothingPreset(
        name=PRESET_CHAOTIC,
        micro_flip_absorb_max_duration_sec=0.60,
        micro_flip_absorb_max_words=3,
        interjection_preserve_min_duration_sec=0.80,
        interjection_preserve_min_words=3,
        same_speaker_stitch_gap_sec=1.20,
        turn_gap_split_sec=2.50,
        low_assignment_score=0.60,
        low_assignment_margin=0.25,
        overlap_flagging="aggressive",
    ),
    PRESET_FORCED_TWO_HOST: SmoothingPreset(
        name=PRESET_FORCED_TWO_HOST,
        micro_flip_absorb_max_duration_sec=0.50,
        micro_flip_absorb_max_words=2,
        interjection_preserve_min_duration_sec=0.70,
        interjection_preserve_min_words=3,
        same_speaker_stitch_gap_sec=1.00,
        turn_gap_split_sec=2.50,
        low_assignment_score=0.55,
        low_assignment_margin=0.20,
        overlap_flagging="normal",
    ),
}


def get_preset(name: str) -> SmoothingPreset:
    return PRESETS.get(name, PRESETS[PRESET_NORMAL])


def apply_smoothing_intensity(preset: SmoothingPreset, intensity: str | None) -> SmoothingPreset:
    """Adjust preset thresholds for --speaker-smoothing normal|aggressive|conservative."""
    if not intensity or intensity == "normal":
        return preset

    if intensity == "aggressive":
        return SmoothingPreset(
            name=preset.name,
            micro_flip_absorb_max_duration_sec=min(preset.micro_flip_absorb_max_duration_sec + 0.15, 0.80),
            micro_flip_absorb_max_words=min(preset.micro_flip_absorb_max_words + 1, 3),
            interjection_preserve_min_duration_sec=max(preset.interjection_preserve_min_duration_sec - 0.15, 0.40),
            interjection_preserve_min_words=max(preset.interjection_preserve_min_words - 1, 2),
            same_speaker_stitch_gap_sec=min(preset.same_speaker_stitch_gap_sec + 0.20, 1.50),
            turn_gap_split_sec=max(preset.turn_gap_split_sec - 0.30, 1.80),
            low_assignment_score=min(preset.low_assignment_score + 0.05, 0.70),
            low_assignment_margin=min(preset.low_assignment_margin + 0.05, 0.30),
            overlap_flagging="aggressive",
        )

    return SmoothingPreset(
        name=preset.name,
        micro_flip_absorb_max_duration_sec=max(preset.micro_flip_absorb_max_duration_sec - 0.10, 0.30),
        micro_flip_absorb_max_words=max(preset.micro_flip_absorb_max_words - 1, 1),
        interjection_preserve_min_duration_sec=preset.interjection_preserve_min_duration_sec + 0.20,
        interjection_preserve_min_words=preset.interjection_preserve_min_words + 1,
        same_speaker_stitch_gap_sec=max(preset.same_speaker_stitch_gap_sec - 0.20, 0.50),
        turn_gap_split_sec=min(preset.turn_gap_split_sec + 0.50, 4.00),
        low_assignment_score=max(preset.low_assignment_score - 0.05, 0.45),
        low_assignment_margin=max(preset.low_assignment_margin - 0.05, 0.10),
        overlap_flagging="normal",
    )


def preset_to_dict(preset: SmoothingPreset) -> dict[str, Any]:
    return {
        "name": preset.name,
        "micro_flip_absorb_max_duration_sec": preset.micro_flip_absorb_max_duration_sec,
        "micro_flip_absorb_max_words": preset.micro_flip_absorb_max_words,
        "interjection_preserve_min_duration_sec": preset.interjection_preserve_min_duration_sec,
        "interjection_preserve_min_words": preset.interjection_preserve_min_words,
        "same_speaker_stitch_gap_sec": preset.same_speaker_stitch_gap_sec,
        "turn_gap_split_sec": preset.turn_gap_split_sec,
        "overlap_flagging": preset.overlap_flagging,
    }
