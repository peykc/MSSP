#!/usr/bin/env python3
"""Offline unit checks for v2 transcript modules (no GPU)."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cache_manager import CACHE_SCHEMA_VERSION, TranscriptCache, hash_config, safe_episode_key
from acoustic_rescore import MIN_SPAN_SEC
from cluster_merge import _clamp_embedding_span
from speaker_assignment import (
    NEARBY_SCORE_MAX,
    NEARBY_SCORE_MIN,
    assign_words_from_diarization,
    detect_overlap_possible,
    percent_unknown_words,
    score_word_candidates,
    serialize_diarization_segments,
)
from speaker_analyzer import analyze_speakers, compute_speaker_stats, detect_overclustered_two_host
from turn_builder import (
    build_speech_turns,
    group_words_into_turns,
    repair_orphan_boundary_tokens,
    resolve_ambiguous_spans,
    should_isolate_uncertain_interjection,
    smooth_speaker_flips,
)
from row_builder import (
    compute_display_diagnostics,
    is_bad_single_word_row,
    split_turn_into_rows,
    should_split_at_sentence_boundary,
)
from presets import get_preset, apply_smoothing_intensity
from row_builder import ROW_STRATEGY_V2, rebuild_display_rows, verify_row_word_integrity
from vad import build_transcribe_vad_kwargs, default_vad_settings


def test_assignment_scores_clamped():
    words = [
        {"body": "hello", "startTime": 1.0, "endTime": 1.4},
        {"body": "yeah", "startTime": 1.5, "endTime": 1.7},
    ]
    diar = [
        {"startTime": 0.9, "endTime": 1.45, "speaker": "SPEAKER_00", "source": "pyannote"},
        {"startTime": 1.48, "endTime": 1.8, "speaker": "SPEAKER_01", "source": "pyannote"},
    ]
    out = assign_words_from_diarization(words, diar, padding_sec=0.1)
    assert 0.0 <= out[0]["speakerAssignmentScore"] <= 1.0
    assert out[0]["speaker"] == "SPEAKER_00"
    assert out[1]["speaker"] == "SPEAKER_01"


def test_no_overlap_unknown():
    words = [{"body": "orphan", "startTime": 10.0, "endTime": 10.2}]
    out = assign_words_from_diarization(words, [], padding_sec=0.1)
    assert out[0]["speaker"] == "UNKNOWN"
    assert out[0]["speakerSource"] == "no_overlap"
    assert out[0]["speakerAssignmentScore"] == 0.0


def test_cache_envelope_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        cache = TranscriptCache(Path(tmp))
        audio_hash = "sha256:test"
        config_hash = hash_config({"stage": "asr"})
        cache.save_stage("ep1", "asr", {"ok": True}, audio_hash=audio_hash, config_hash=config_hash)
        loaded = cache.load_stage("ep1", "asr", audio_hash=audio_hash, config_hash=config_hash)
        assert loaded == {"ok": True}
        raw = json.loads((Path(tmp) / "ep1.asr.json").read_text(encoding="utf-8"))
        assert raw["cacheSchemaVersion"] == CACHE_SCHEMA_VERSION


def test_turn_and_row_pipeline():
    words = [
        {"body": "I", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.9, "speakerAssignmentMargin": 0.5},
        {"body": "was", "startTime": 0.12, "endTime": 0.2, "speaker": "SPEAKER_04", "speakerAssignmentScore": 0.3, "speakerAssignmentMargin": 0.05},
        {"body": "saying", "startTime": 0.22, "endTime": 0.5, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.88, "speakerAssignmentMargin": 0.4},
    ]
    analysis = analyze_speakers(words, duration_seconds=30.0, speaker_mode="adaptive")
    turns, counters = build_speech_turns(words, analysis)
    segments, flat = rebuild_display_rows(
        words,
        strategy=ROW_STRATEGY_V2,
        speech_turns=turns,
        word_segments=words,
        diarized=True,
    )
    integrity = verify_row_word_integrity(segments, flat)
    assert integrity["ok"]
    assert counters["absorbedMicroFlipCount"] >= 0


def test_speaker_stats_use_global_turns():
    words = [
        {"body": "a", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00"},
        {"body": "b", "startTime": 0.2, "endTime": 0.3, "speaker": "SPEAKER_01"},
        {"body": "c", "startTime": 1.0, "endTime": 1.1, "speaker": "SPEAKER_00"},
        {"body": "d", "startTime": 1.2, "endTime": 1.3, "speaker": "SPEAKER_01"},
        {"body": "e", "startTime": 2.0, "endTime": 2.1, "speaker": "SPEAKER_00"},
    ]
    stats = compute_speaker_stats(words, duration_seconds=10.0)
    assert stats["SPEAKER_00"]["turnCount"] == 3
    assert stats["SPEAKER_01"]["turnCount"] == 2


def test_span_micro_flip_absorbs_two_words():
    words = [
        {"body": "I", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.9, "speakerAssignmentMargin": 0.5},
        {"body": "was", "startTime": 0.12, "endTime": 0.2, "speaker": "SPEAKER_04", "speakerAssignmentScore": 0.3, "speakerAssignmentMargin": 0.16},
        {"body": "just", "startTime": 0.22, "endTime": 0.3, "speaker": "SPEAKER_04", "speakerAssignmentScore": 0.25, "speakerAssignmentMargin": 0.17},
        {"body": "saying", "startTime": 0.32, "endTime": 0.5, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.88, "speakerAssignmentMargin": 0.4},
    ]
    preset = get_preset("normal")
    classes = {"SPEAKER_00": "main", "SPEAKER_04": "glitch"}
    smoothed, absorbed = smooth_speaker_flips(words, classes, preset)
    assert absorbed == 2
    assert smoothed[1]["speaker"] == "SPEAKER_00"
    assert smoothed[2]["speaker"] == "SPEAKER_00"


def test_overlap_possible_flag():
    candidates = {"SPEAKER_00": 0.40, "SPEAKER_01": 0.30}
    assert detect_overlap_possible(candidates)
    words = [{"body": "hey", "startTime": 1.0, "endTime": 1.4}]
    diar = [
        {"startTime": 0.9, "endTime": 1.45, "speaker": "SPEAKER_00", "source": "pyannote"},
        {"startTime": 0.95, "endTime": 1.5, "speaker": "SPEAKER_01", "source": "pyannote"},
    ]
    out = assign_words_from_diarization(words, diar, padding_sec=0.1)
    assert "overlap_possible" in (out[0].get("flags") or [])


def test_smoothing_intensity_adjusts_preset():
    base = get_preset("normal")
    aggressive = apply_smoothing_intensity(base, "aggressive")
    conservative = apply_smoothing_intensity(base, "conservative")
    assert aggressive.micro_flip_absorb_max_words > base.micro_flip_absorb_max_words
    assert conservative.micro_flip_absorb_max_words < base.micro_flip_absorb_max_words


def test_nearby_padding_rescues_boundary_word():
    word = {"body": "hey", "startTime": 1.03, "endTime": 1.20}
    diar = [{"startTime": 0.90, "endTime": 1.00, "speaker": "SPEAKER_00", "source": "pyannote"}]
    candidates, sources = score_word_candidates(word, diar, padding_sec=0.10)
    assert "SPEAKER_00" in candidates
    assert sources["SPEAKER_00"] == "diarization_nearby"
    assert NEARBY_SCORE_MIN <= candidates["SPEAKER_00"] <= NEARBY_SCORE_MAX

    out = assign_words_from_diarization([word], diar, padding_sec=0.10)
    assert out[0]["speaker"] == "SPEAKER_00"
    assert out[0]["speakerSource"] == "diarization_nearby"
    assert "diarization_nearby" in (out[0].get("flags") or [])


def test_same_speaker_turn_splits_on_long_pause():
    words = [
        {"body": "hello", "startTime": 0.0, "endTime": 0.2, "speaker": "SPEAKER_00"},
        {"body": "world", "startTime": 3.0, "endTime": 3.2, "speaker": "SPEAKER_00"},
    ]
    preset = get_preset("normal")
    turns = group_words_into_turns(words, preset)
    assert len(turns) == 2


def test_embedding_span_stays_below_waveform_boundary():
    num_samples = 74_011_792
    start, end = _clamp_embedding_span(
        4_624.0,
        num_samples / 16_000,
        num_samples,
    )
    assert start == 4_624.0
    assert round(end * 16_000) < num_samples
    assert end == (num_samples - 1) / 16_000
    # Acoustic-rescore end-of-file spans must still be long enough to evaluate.
    assert end - start >= MIN_SPAN_SEC


def test_asr_cache_hash_uses_requested_compute_type():
    from pathlib import Path
    from transcribe import RunConfig

    requested = RunConfig(
        input_dir=Path("."),
        output_dir=Path("."),
        cache_dir=Path("."),
        requested_model="large-v3-turbo",
        compute_type="int8_float16",
        requested_compute_type="float16",
        device="cuda",
    )
    hash_requested = requested.asr_config_hash()
    requested.compute_type = "int8_float16"
    assert requested.asr_config_hash() == hash_requested


def test_transcribe_vad_kwargs_empty():
    assert build_transcribe_vad_kwargs(default_vad_settings()) == {}
    assert build_transcribe_vad_kwargs(None) == {}


def test_serialize_diarization_dataframe_shape():
    class FakeRow:
        def __init__(self, data: dict):
            self._data = data

        def get(self, key: str, default=None):
            return self._data.get(key, default)

    class FakeDataFrame:
        columns = ["start", "end", "speaker"]

        def __init__(self, rows: list[dict]):
            self._rows = rows

        def __len__(self):
            return len(self._rows)

        def iterrows(self):
            for index, row in enumerate(self._rows):
                yield index, FakeRow(row)

    raw = FakeDataFrame(
        [
            {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
            {"start": 1.6, "end": 3.0, "speaker": "SPEAKER_01"},
        ]
    )
    segments = serialize_diarization_segments(raw)
    assert len(segments) == 2
    assert segments[0]["speaker"] == "SPEAKER_00"


def test_percent_unknown_words():
    words = [
        {"speaker": "UNKNOWN"},
        {"speaker": "SPEAKER_00"},
        {"speaker": "UNKNOWN"},
        {"speaker": "SPEAKER_01"},
    ]
    assert percent_unknown_words(words) == 50.0


def test_uncertain_words_block_micro_flip_absorption():
    words = [
        {"body": "I", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.9, "speakerAssignmentMargin": 0.5},
        {"body": "was", "startTime": 0.12, "endTime": 0.2, "speaker": "SPEAKER_04", "speakerAssignmentScore": 0.3, "speakerAssignmentMargin": 0.05},
        {"body": "saying", "startTime": 0.22, "endTime": 0.5, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.88, "speakerAssignmentMargin": 0.4},
    ]
    preset = get_preset("normal")
    classes = {"SPEAKER_00": "main", "SPEAKER_04": "glitch"}
    _, absorbed = smooth_speaker_flips(words, classes, preset)
    assert absorbed == 0


def test_ambiguous_prefix_span_resolves_to_next_speaker():
    words = [
        {"body": "No.", "startTime": 0.0, "endTime": 0.2, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.4},
        {"body": "If", "startTime": 0.3, "endTime": 0.35, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.0, "flags": ["overlap_possible"], "speakerCandidates": {"SPEAKER_02": 1.0, "SPEAKER_04": 1.0}},
        {"body": "I", "startTime": 0.36, "endTime": 0.4, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.0, "flags": ["overlap_possible"], "speakerCandidates": {"SPEAKER_02": 1.0, "SPEAKER_04": 1.0}},
        {"body": "were", "startTime": 0.41, "endTime": 0.5, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.0, "flags": ["overlap_possible"], "speakerCandidates": {"SPEAKER_02": 1.0, "SPEAKER_04": 1.0}},
        {"body": "to", "startTime": 0.55, "endTime": 0.6, "speaker": "SPEAKER_04", "speakerAssignmentMargin": 0.5},
        {"body": "lay", "startTime": 0.62, "endTime": 0.7, "speaker": "SPEAKER_04", "speakerAssignmentMargin": 0.5},
    ]
    preset = get_preset("normal")
    resolved, count = resolve_ambiguous_spans(words, preset)
    assert count == 1
    assert resolved[1]["speaker"] == "SPEAKER_04"
    assert resolved[2]["speaker"] == "SPEAKER_04"
    assert resolved[3]["speaker"] == "SPEAKER_04"
    turns = group_words_into_turns(resolved, preset)
    assert len(turns) == 2
    assert turns[0][-1]["body"] == "No."
    assert len(turns[1]) == 5


def test_uncertain_interjection_splits_turn():
    words = [
        {"body": "it", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {"body": "has", "startTime": 0.12, "endTime": 0.2, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {"body": "a", "startTime": 0.22, "endTime": 0.25, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {"body": "nice", "startTime": 0.27, "endTime": 0.4, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {"body": "bust", "startTime": 0.42, "endTime": 0.6, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {
            "body": "Yes.",
            "startTime": 0.62,
            "endTime": 0.7,
            "speaker": "SPEAKER_00",
            "speakerAssignmentMargin": 0.05,
            "speakerCandidates": {"SPEAKER_00": 0.4, "SPEAKER_01": 0.35},
            "flags": ["overlap_possible"],
        },
    ]
    preset = get_preset("normal")
    resolved, _ = resolve_ambiguous_spans(words, preset)
    turns = group_words_into_turns(resolved, preset)
    assert len(turns) == 2
    assert turns[-1][0]["body"] == "Yes."


def test_long_question_not_marked_uncertain_interjection():
    words = [
        {"body": "so", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.0, "flags": ["overlap_possible"]},
    ] + [
        {"body": f"w{i}", "startTime": 0.1 + i * 0.1, "endTime": 0.15 + i * 0.1, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.4}
        for i in range(1, 10)
    ]
    analysis = {"recommendedPreset": "normal", "speakerClasses": {"SPEAKER_00": "main"}}
    turns, _ = build_speech_turns(words, analysis)
    assert "uncertain_interjection" not in (turns[0].get("flags") or [])


def test_sentence_boundary_splits_display_rows():
    turn_words = [
        {"body": "Welcome", "startTime": 0.0, "endTime": 0.2},
        {"body": "to", "startTime": 0.22, "endTime": 0.3},
        {"body": "the", "startTime": 0.32, "endTime": 0.4},
        {"body": "secret", "startTime": 0.42, "endTime": 0.55},
        {"body": "podcast.", "startTime": 0.57, "endTime": 0.8},
        {"body": "Top", "startTime": 1.68, "endTime": 1.8},
        {"body": "secret", "startTime": 1.82, "endTime": 1.95},
        {"body": "stuff", "startTime": 1.97, "endTime": 2.1},
        {"body": "going", "startTime": 2.12, "endTime": 2.25},
        {"body": "on", "startTime": 2.27, "endTime": 2.35},
        {"body": "over", "startTime": 2.37, "endTime": 2.5},
        {"body": "here.", "startTime": 2.52, "endTime": 2.7},
    ]
    assert should_split_at_sentence_boundary(turn_words[:5], turn_words[5], turn_words, 5)
    rows = split_turn_into_rows(turn_words, 0, True, 6, 40, 56, 1.5)
    assert len(rows) == 2
    assert "podcast." in rows[0]["body"]
    assert rows[1]["body"].startswith("Top")


def test_sentence_prefix_reattaches_orphan_it():
    words = [
        {"body": "behind?", "startTime": 5.0, "endTime": 5.2, "speaker": "SPEAKER_04", "speakerAssignmentMargin": 0.5},
        {"body": "It", "startTime": 5.25, "endTime": 5.35, "speaker": "SPEAKER_04", "speakerAssignmentMargin": 0.5},
        {"body": "wouldn't", "startTime": 5.36, "endTime": 5.5, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.5},
        {"body": "work,", "startTime": 5.52, "endTime": 5.6, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.5},
        {"body": "no.", "startTime": 5.62, "endTime": 5.7, "speaker": "SPEAKER_02", "speakerAssignmentMargin": 0.5},
    ]
    preset = get_preset("normal")
    repaired, counters = repair_orphan_boundary_tokens(words, preset)
    assert counters["sentencePrefixReattachedCount"] == 1
    assert repaired[1]["speaker"] == "SPEAKER_02"
    turns = group_words_into_turns(repaired, preset)
    assert len(turns) == 2
    assert turns[0][-1]["body"] == "behind?"
    assert [w["body"] for w in turns[1]] == ["It", "wouldn't", "work,", "no."]


def test_phrase_internal_orphan_absorbed():
    words = [
        {"body": "Oh", "startTime": 0.0, "endTime": 0.1, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
        {"body": "my", "startTime": 0.12, "endTime": 0.2, "speaker": "SPEAKER_01", "speakerAssignmentMargin": 0.5},
        {"body": "God.", "startTime": 0.22, "endTime": 0.4, "speaker": "SPEAKER_00", "speakerAssignmentMargin": 0.5},
    ]
    preset = get_preset("normal")
    repaired, counters = repair_orphan_boundary_tokens(words, preset)
    assert counters["orphanBoundaryTokenAbsorbedCount"] == 1
    assert repaired[1]["speaker"] == "SPEAKER_00"


def test_bad_single_word_row_detection():
    segments = [
        {
            "body": "If I were to lay on it from behind?",
            "words": [{"body": "If"}, {"body": "behind?"}],
            "startTime": 0.0,
            "endTime": 5.2,
        },
        {"body": "It", "words": [{"body": "It"}], "startTime": 5.25, "endTime": 5.35},
        {
            "body": "wouldn't work, no.",
            "words": [{"body": "wouldn't"}, {"body": "no."}],
            "startTime": 5.36,
            "endTime": 5.7,
        },
    ]
    assert is_bad_single_word_row(segments[1], segments[0], segments[2])
    assert not is_bad_single_word_row(
        {"body": "No.", "words": [{"body": "No."}], "startTime": 1.0, "endTime": 1.2},
        None,
        {"body": "If I were", "words": [{"body": "If"}], "startTime": 2.0, "endTime": 2.5},
    )
    diag = compute_display_diagnostics(segments, [], diarized=True)
    assert diag["badSingleWordSegmentCount"] == 1


def test_overclustered_two_host_preset():
    stats = {
        f"SPEAKER_{idx:02d}": {"percentOfEpisodeWords": share, "turnCount": 4, "cleanTurnCount": 2, "totalSpeechSeconds": 30}
        for idx, share in enumerate([46.8, 30.6, 9.2, 3.1, 2.5, 2.0, 1.8, 1.5])
    }
    assert detect_overclustered_two_host(stats)
    words = []
    for speaker, stat in stats.items():
        count = max(1, int(stat["percentOfEpisodeWords"]))
        for i in range(count):
            words.append({
                "body": f"w{i}",
                "startTime": float(i),
                "endTime": float(i) + 0.1,
                "speaker": speaker,
                "speakerAssignmentScore": 0.9,
                "speakerAssignmentMargin": 0.5,
            })
    analysis = analyze_speakers(words, duration_seconds=3600.0, speaker_mode="adaptive")
    assert analysis["diarizationPattern"] == "overclustered_two_host"
    assert analysis["recommendedPreset"] == "normal"
    assert analysis["stabilizeSmoothing"] == "aggressive"
    assert analysis["credibleSpeakerCount"] <= 4


def test_speaker_analysis_json_serializable():
    words = [
        {"body": "hello", "startTime": 0.0, "endTime": 0.3, "speaker": "SPEAKER_00", "speakerAssignmentScore": 0.9, "speakerAssignmentMargin": 0.5},
    ]
    analysis = analyze_speakers(words, duration_seconds=30.0, speaker_mode="adaptive")
    assert isinstance(analysis["appliedPreset"], dict)
    json.dumps(analysis)


def test_sanitize_json_value_handles_dataclass():
    from transcribe import sanitize_json_value

    preset_dict = sanitize_json_value(get_preset("normal"))
    assert isinstance(preset_dict, dict)
    assert preset_dict["name"] == "normal"


def test_asr_model_fallback_is_explicit_and_cache_keyed():
    from transcribe import RunConfig, asr_model_candidates, model_dependency_versions

    assert asr_model_candidates("large-v3", allow_fallback=False) == ["large-v3"]
    candidates = asr_model_candidates("large-v3", allow_fallback=True)
    assert candidates[0] == "large-v3"
    assert "large-v3-turbo" in candidates
    assert len(candidates) == len(set(candidates))
    assert "whisperx" in model_dependency_versions()
    assert "pyannote-audio" in model_dependency_versions()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        strict = RunConfig(root, root, root, "large-v3", allow_model_fallback=False)
        permissive = RunConfig(root, root, root, "large-v3", allow_model_fallback=True)
        assert strict.asr_config_hash() != permissive.asr_config_hash()


def test_parallel_output_validation_checks_model_and_diarization():
    from transcribe_parallel import inspect_transcript_output, passthrough_option

    assert passthrough_option(["--model", "large-v3"], "--model", "default") == "large-v3"
    assert passthrough_option(["--model=large-v3"], "--model", "default") == "large-v3"
    assert (
        passthrough_option(
            ["--model", "large-v3-turbo", "--model=large-v3"],
            "--model",
            "default",
        )
        == "large-v3"
    )

    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "episode.json"
        output.write_text(
            json.dumps(
                {
                    "version": "1.2.0",
                    "format": "mssp-transcript",
                    "metadata": {
                        "model": "large-v3",
                        "requested_model": "large-v3",
                        "diarized": True,
                    },
                    "segments": [],
                    "wordSegments": [],
                    "rawSegments": [],
                    "diarizationSegments": [],
                    "speechTurns": [],
                    "diagnostics": {
                        "wordCount": 0,
                        "segmentCount": 0,
                        "speechTurnCount": 0,
                        "rowWordIntegrityOk": True,
                        "singleWordSegmentPercent": 0,
                    },
                }
            ),
            encoding="utf-8",
        )
        valid, reason, actual = inspect_transcript_output(
            output,
            expected_model="large-v3",
            require_diarized=True,
        )
        assert valid and reason is None and actual == "large-v3"

        valid, reason, _ = inspect_transcript_output(
            output,
            expected_model="large-v3-turbo",
            require_diarized=True,
        )
        assert not valid and reason and "expected large-v3-turbo" in reason

        fallback_document = json.loads(output.read_text(encoding="utf-8"))
        fallback_document["metadata"]["model"] = "large-v3-turbo"
        output.write_text(json.dumps(fallback_document), encoding="utf-8")
        valid, reason, actual = inspect_transcript_output(
            output,
            expected_model="large-v3",
            require_diarized=True,
            allow_model_fallback=True,
        )
        assert valid and reason is None and actual == "large-v3-turbo"


def test_only_list_absolute_paths_and_nested_cache_keys():
    from transcribe import apply_file_filters, episode_cache_key
    from transcribe_parallel import find_output_collisions

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        first = root / "season-1" / "episode.mp3"
        second = root / "season-2" / "episode.mp3"
        first.parent.mkdir()
        second.parent.mkdir()
        first.touch()
        second.touch()

        selected = apply_file_filters(
            [first, second],
            start_after=None,
            limit=None,
            test=False,
            only=None,
            only_list=[str(second.resolve())],
        )
        assert selected == [second]
        assert episode_cache_key(first, root) == "season-1/episode"
        assert episode_cache_key(second, root) == "season-2/episode"
        assert safe_episode_key("season-1/episode") != safe_episode_key("season-1_episode")
        output_root = root / "output"
        assert find_output_collisions([first, second], root, output_root, False)
        assert not find_output_collisions([first, second], root, output_root, True)


def _manifest_writer(root_value: str, worker_index: int, barrier) -> None:
    from transcribe import ManifestItem, RunConfig, update_manifest_atomic

    root = Path(root_value)
    config = RunConfig(root, root, root / ".cache", "large-v3")
    barrier.wait(timeout=10)
    for item_index in range(10):
        unique_index = worker_index * 10 + item_index
        update_manifest_atomic(
            root,
            ManifestItem(
                f"episode-{unique_index}.mp3",
                f"episode-{unique_index}",
                f"episode-{unique_index}.json",
                "ok",
            ),
            config,
        )


def test_manifest_update_preserves_same_named_nested_outputs():
    from transcribe import ManifestItem, RunConfig, load_manifest, update_manifest_atomic

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        config = RunConfig(root, root, root / ".cache", "large-v3")
        update_manifest_atomic(
            root,
            ManifestItem("episode.mp3", "episode", "season-1/episode.json", "ok"),
            config,
        )
        update_manifest_atomic(
            root,
            ManifestItem("episode.mp3", "episode", "season-2/episode.json", "ok"),
            config,
        )
        manifest = load_manifest(root / "index.json")
        paths = {item["transcriptFile"] for item in manifest["items"]}
        assert paths == {"season-1/episode.json", "season-2/episode.json"}


def test_manifest_updates_are_cross_process_safe():
    import multiprocessing

    with tempfile.TemporaryDirectory() as tmp:
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(4)
        processes = [
            context.Process(target=_manifest_writer, args=(tmp, index, barrier))
            for index in range(4)
        ]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=20)
            assert process.exitcode == 0

        manifest = json.loads((Path(tmp) / "index.json").read_text(encoding="utf-8"))
        assert len(manifest["items"]) == 40


def main() -> None:
    test_assignment_scores_clamped()
    test_no_overlap_unknown()
    test_cache_envelope_roundtrip()
    test_turn_and_row_pipeline()
    test_speaker_stats_use_global_turns()
    test_span_micro_flip_absorbs_two_words()
    test_uncertain_words_block_micro_flip_absorption()
    test_overlap_possible_flag()
    test_smoothing_intensity_adjusts_preset()
    test_nearby_padding_rescues_boundary_word()
    test_same_speaker_turn_splits_on_long_pause()
    test_embedding_span_stays_below_waveform_boundary()
    test_asr_cache_hash_uses_requested_compute_type()
    test_transcribe_vad_kwargs_empty()
    test_serialize_diarization_dataframe_shape()
    test_percent_unknown_words()
    test_ambiguous_prefix_span_resolves_to_next_speaker()
    test_uncertain_interjection_splits_turn()
    test_long_question_not_marked_uncertain_interjection()
    test_sentence_boundary_splits_display_rows()
    test_sentence_prefix_reattaches_orphan_it()
    test_phrase_internal_orphan_absorbed()
    test_bad_single_word_row_detection()
    test_overclustered_two_host_preset()
    test_speaker_analysis_json_serializable()
    test_sanitize_json_value_handles_dataclass()
    test_asr_model_fallback_is_explicit_and_cache_keyed()
    test_parallel_output_validation_checks_model_and_diarization()
    test_only_list_absolute_paths_and_nested_cache_keys()
    test_manifest_update_preserves_same_named_nested_outputs()
    test_manifest_updates_are_cross_process_safe()
    print("All v2 module checks passed.")


if __name__ == "__main__":
    main()
