"""Embedding-based merge of over-clustered diarization speakers.

pyannote frequently splits one real speaker into several SPEAKER_xx clusters
(e.g. Ep. 1 put Shane in three). This module embeds each cluster's speech with a
speaker-verification model, and merges clusters whose voiceprints are near-identical.

Validated on the eval episodes (see eval/ground-truth): same-speaker cluster pairs
scored 0.82-0.84 cosine similarity, while distinct speakers scored <= 0.67 (guest
Billy vs Shane hit 0.67, the two hosts 0.47), so the default threshold sits at 0.70.
Lowering it toward 0.60 starts merging real people into each other.

Centroids depend only on the audio and the diarization timeline - never on the
threshold - so they are cached inside the diarization stage payload and merge maps
can be re-derived instantly for any threshold.
"""

from __future__ import annotations

from typing import Any

DEFAULT_CLUSTER_MERGE_THRESHOLD = 0.70
MIN_SEGMENT_DURATION_SEC = 0.75   # embeddings on shorter clips are unreliable
MAX_SEGMENTS_PER_CLUSTER = 40     # longest N segments bound embedding cost
EMBEDDING_MODEL_NAME = "pyannote/wespeaker-voxceleb-resnet34-LM"
SAMPLE_RATE = 16000


def load_embedding_inference(hf_token: str | None, device: str | None = None) -> Any:
    """Shared speaker-embedding Inference used by cluster merge and acoustic rescore."""
    import torch
    from pyannote.audio import Inference, Model

    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    # pyannote.audio 4.x renamed `use_auth_token` to `token`.
    model = Model.from_pretrained(EMBEDDING_MODEL_NAME, token=hf_token)
    return Inference(model, window="whole", device=torch.device(device))


def merged_centroids(
    cluster_stats: dict[str, dict[str, Any]],
    merge_map: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Duration-weighted centroids per post-merge cluster (unit-normalized ndarrays)."""
    import numpy as np

    merge_map = merge_map or {}
    agg: dict[str, Any] = {}
    for cluster, info in cluster_stats.items():
        vec = np.asarray(info.get("centroid") or [], dtype=np.float64)
        weight = float(info.get("speechSeconds") or 0.0)
        if vec.size == 0 or weight <= 0:
            continue
        canon = merge_map.get(cluster, cluster)
        agg[canon] = agg.get(canon, 0) + vec * weight
    out = {}
    for canon, vec in agg.items():
        norm = np.linalg.norm(vec)
        if np.isfinite(norm) and norm > 0:
            out[canon] = vec / norm
    return out


def compute_cluster_stats(
    audio: Any,
    diarization_segments: list[dict[str, Any]],
    hf_token: str | None,
    device: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Return {speaker: {"centroid": [float, ...], "speechSeconds": float}}.

    `audio` is the whisperx.load_audio ndarray (mono float32 @ 16kHz); the waveform
    is passed to pyannote preloaded, which sidesteps the broken torchcodec decoder.
    Clusters whose segments are all shorter than MIN_SEGMENT_DURATION_SEC get no
    entry and are never merged.
    """
    import numpy as np
    import torch
    from pyannote.core import Segment

    inference = load_embedding_inference(hf_token, device)

    waveform = torch.from_numpy(np.asarray(audio)).unsqueeze(0)
    audio_file = {"waveform": waveform, "sample_rate": SAMPLE_RATE}
    total_duration = waveform.shape[1] / SAMPLE_RATE

    by_cluster: dict[str, list[tuple[float, float]]] = {}
    for seg in diarization_segments:
        speaker = seg.get("speaker")
        start = seg.get("startTime")
        end = seg.get("endTime")
        if not speaker or start is None or end is None:
            continue
        start_f = float(start)
        end_f = min(float(end), total_duration)
        if end_f - start_f >= MIN_SEGMENT_DURATION_SEC:
            by_cluster.setdefault(str(speaker), []).append((start_f, end_f))

    stats: dict[str, dict[str, Any]] = {}
    for speaker, spans in sorted(by_cluster.items()):
        spans.sort(key=lambda s: s[1] - s[0], reverse=True)
        embeddings: list[Any] = []
        durations: list[float] = []
        for start_f, end_f in spans[:MAX_SEGMENTS_PER_CLUSTER]:
            emb = inference.crop(audio_file, Segment(start_f, end_f))
            emb = np.asarray(emb, dtype=np.float64).reshape(-1)
            norm = np.linalg.norm(emb)
            if not np.isfinite(norm) or norm == 0:
                continue
            embeddings.append(emb / norm)
            durations.append(end_f - start_f)
        if not embeddings:
            continue
        weights = np.asarray(durations)
        centroid = (np.stack(embeddings) * weights[:, None]).sum(axis=0) / weights.sum()
        centroid = centroid / np.linalg.norm(centroid)
        stats[speaker] = {
            "centroid": [round(float(v), 6) for v in centroid],
            "speechSeconds": round(float(weights.sum()), 3),
        }

    del inference
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return stats


def derive_merge_map(
    cluster_stats: dict[str, dict[str, Any]],
    threshold: float = DEFAULT_CLUSTER_MERGE_THRESHOLD,
) -> dict[str, str]:
    """Agglomerative same-voice merge; returns only the entries that change.

    Repeatedly merges the most-similar cluster pair at/above `threshold`,
    recomputing the duration-weighted centroid after each merge. The canonical
    name for a merged group is its member with the most speech.
    """
    import numpy as np

    centroids: dict[str, Any] = {}
    weights: dict[str, float] = {}
    for speaker, info in cluster_stats.items():
        vec = np.asarray(info.get("centroid") or [], dtype=np.float64)
        if vec.size == 0:
            continue
        norm = np.linalg.norm(vec)
        if not np.isfinite(norm) or norm == 0:
            continue
        centroids[speaker] = vec / norm
        weights[speaker] = float(info.get("speechSeconds") or 0.0)

    groups: dict[str, set[str]] = {c: {c} for c in centroids}
    live = sorted(centroids)
    while True:
        best_pair = None
        best_sim = threshold
        for i, a in enumerate(live):
            for b in live[i + 1 :]:
                sim = float(np.dot(centroids[a], centroids[b]))
                if sim >= best_sim:
                    best_pair, best_sim = (a, b), sim
        if best_pair is None:
            break
        a, b = best_pair
        merged = centroids[a] * weights[a] + centroids[b] * weights[b]
        centroids[a] = merged / np.linalg.norm(merged)
        weights[a] += weights[b]
        groups[a] |= groups.pop(b)
        live.remove(b)

    original_weights = {
        s: float(info.get("speechSeconds") or 0.0) for s, info in cluster_stats.items()
    }
    merge_map: dict[str, str] = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        canonical = max(members, key=lambda m: original_weights.get(m, 0.0))
        for member in members:
            if member != canonical:
                merge_map[member] = canonical
    return merge_map


def apply_merge_map(
    diarization_segments: list[dict[str, Any]],
    merge_map: dict[str, str],
) -> list[dict[str, Any]]:
    """Return diarization segments with merged speaker labels (input unchanged)."""
    if not merge_map:
        return diarization_segments
    remapped: list[dict[str, Any]] = []
    for seg in diarization_segments:
        speaker = seg.get("speaker")
        if speaker in merge_map:
            seg = dict(seg)
            seg["speaker"] = merge_map[speaker]
        remapped.append(seg)
    return remapped
