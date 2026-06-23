"""Stage cache read/write with versioned envelope and config hashing."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CACHE_SCHEMA_VERSION = "transcript-cache-v2.0"
CACHE_SUBDIR = ".cache/transcripts"

STAGE_AUDIO = "audio"
STAGE_VAD = "vad"
STAGE_ASR = "asr"
STAGE_ALIGNED = "aligned"
STAGE_DIARIZATION = "diarization"
STAGE_WORD_SPEAKERS = "word_speakers"
STAGE_SPEECH_TURNS = "speech_turns"

STAGE_SUFFIX = {
    STAGE_AUDIO: "audio.json",
    STAGE_VAD: "vad.json",
    STAGE_ASR: "asr.json",
    STAGE_ALIGNED: "aligned.json",
    STAGE_DIARIZATION: "diarization.json",
    STAGE_WORD_SPEAKERS: "word_speakers.json",
    STAGE_SPEECH_TURNS: "speech_turns.json",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hash_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def hash_config(data: dict[str, Any]) -> str:
    canonical = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def safe_episode_key(stem: str) -> str:
    return stem.replace("/", "_").replace("\\", "_")


class TranscriptCache:
    def __init__(
        self,
        cache_root: Path,
        *,
        cache_schema_version: str = CACHE_SCHEMA_VERSION,
        reuse_cache: bool = True,
    ) -> None:
        self.cache_root = cache_root.resolve()
        self.cache_schema_version = cache_schema_version
        self.reuse_cache = reuse_cache
        self.cache_root.mkdir(parents=True, exist_ok=True)

    def stage_path(self, episode_key: str, stage: str) -> Path:
        suffix = STAGE_SUFFIX[stage]
        return self.cache_root / f"{safe_episode_key(episode_key)}.{suffix}"

    def is_valid(
        self,
        episode_key: str,
        stage: str,
        *,
        audio_hash: str | None = None,
        config_hash: str | None = None,
    ) -> bool:
        path = self.stage_path(episode_key, stage)
        if not path.is_file():
            return False
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return False
        if envelope.get("cacheSchemaVersion") != self.cache_schema_version:
            return False
        if envelope.get("stage") != stage:
            return False
        if audio_hash is not None and envelope.get("audioHash") != audio_hash:
            return False
        if config_hash is not None and envelope.get("configHash") != config_hash:
            return False
        return "payload" in envelope

    def load_stage(
        self,
        episode_key: str,
        stage: str,
        *,
        audio_hash: str | None = None,
        config_hash: str | None = None,
    ) -> dict[str, Any] | None:
        if not self.reuse_cache:
            return None
        if not self.is_valid(episode_key, stage, audio_hash=audio_hash, config_hash=config_hash):
            return None
        path = self.stage_path(episode_key, stage)
        envelope = json.loads(path.read_text(encoding="utf-8"))
        return envelope.get("payload")

    def save_stage(
        self,
        episode_key: str,
        stage: str,
        payload: dict[str, Any],
        *,
        audio_hash: str,
        config_hash: str,
    ) -> Path:
        path = self.stage_path(episode_key, stage)
        envelope = {
            "cacheSchemaVersion": self.cache_schema_version,
            "stage": stage,
            "createdAt": utc_now_iso(),
            "configHash": config_hash,
            "audioHash": audio_hash,
            "payload": payload,
        }
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(envelope, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
        return path

    def invalidate(self, episode_key: str, stage: str | None = None) -> None:
        if stage is not None:
            path = self.stage_path(episode_key, stage)
            if path.exists():
                path.unlink()
            return
        prefix = safe_episode_key(episode_key) + "."
        for path in self.cache_root.glob(f"{prefix}*"):
            if path.is_file():
                path.unlink()
