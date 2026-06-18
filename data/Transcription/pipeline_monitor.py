"""Stage timing, progress reporting, and GPU snapshots for the transcription pipeline."""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable


def capture_gpu_memory() -> dict[str, float] | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free_b, total_b = torch.cuda.mem_get_info()
        return {
            "allocatedGb": round(torch.cuda.memory_allocated() / 1024**3, 2),
            "reservedGb": round(torch.cuda.memory_reserved() / 1024**3, 2),
            "freeGb": round(free_b / 1024**3, 2),
            "totalGb": round(total_b / 1024**3, 1),
        }
    except Exception:
        return None


def _format_gpu(mem: dict[str, float] | None) -> str:
    if not mem:
        return ""
    return (
        f" | GPU {mem['allocatedGb']:.2f}GB alloc, "
        f"{mem['freeGb']:.2f}GB free / {mem['totalGb']:.1f}GB"
    )


@dataclass
class StageStats:
    name: str
    device: str | None = None
    started_at: float = 0.0
    ended_at: float | None = None
    last_progress_pct: float = 0.0
    gpu_memory: dict[str, Any] | None = None
    error: str | None = None

    @property
    def elapsed_sec(self) -> float | None:
        if self.ended_at is None:
            return round(time.monotonic() - self.started_at, 2)
        return round(self.ended_at - self.started_at, 2)

    def to_dict(self) -> dict[str, Any]:
        item: dict[str, Any] = {
            "name": self.name,
            "elapsedSeconds": self.elapsed_sec,
            "lastProgressPercent": round(self.last_progress_pct, 1),
        }
        if self.device:
            item["device"] = self.device
        if self.gpu_memory:
            item["gpuMemory"] = self.gpu_memory
        if self.error:
            item["error"] = self.error
        return item


@dataclass
class PipelineMonitor:
    """Tracks per-stage timing, progress %, and optional GPU snapshots."""

    file_label: str
    enabled: bool = True
    progress_interval_sec: float = 5.0
    progress_step_pct: float = 5.0
    stages: list[StageStats] = field(default_factory=list)
    _current: StageStats | None = field(default=None, repr=False)
    _last_progress_print: float = field(default=0.0, repr=False)
    _last_pct_bucket: float = field(default=-1.0, repr=False)

    def start_stage(self, name: str, device: str | None = None) -> None:
        self.end_stage()
        gpu = capture_gpu_memory()
        self._current = StageStats(
            name=name,
            device=device,
            started_at=time.monotonic(),
            gpu_memory={"start": gpu} if gpu else None,
        )
        self._last_progress_print = 0.0
        self._last_pct_bucket = -1.0
        if self.enabled:
            print(
                f"  [{name}] starting (device={device or 'n/a'}){_format_gpu(gpu)}",
                flush=True,
            )

    def end_stage(self) -> None:
        if self._current is None or self._current.ended_at is not None:
            return
        self._current.ended_at = time.monotonic()
        gpu = capture_gpu_memory()
        if self._current.gpu_memory and gpu:
            self._current.gpu_memory["end"] = gpu
        if self.enabled:
            elapsed = self._current.elapsed_sec or 0.0
            pct_note = ""
            if self._current.last_progress_pct > 0:
                pct_note = f" | last progress {self._current.last_progress_pct:.0f}%"
            print(
                f"  [{self._current.name}] done in {elapsed:.1f}s{pct_note}{_format_gpu(gpu)}",
                flush=True,
            )
        self.stages.append(self._current)
        self._current = None

    def fail_current(self, error: str) -> None:
        if self._current is None:
            return
        self._current.error = error
        self._current.ended_at = time.monotonic()
        if self.enabled:
            elapsed = self._current.elapsed_sec or 0.0
            print(
                f"  [{self._current.name}] FAILED after {elapsed:.1f}s "
                f"at {self._current.last_progress_pct:.0f}%: {error}",
                file=sys.stderr,
                flush=True,
            )
        self.stages.append(self._current)
        self._current = None

    def progress_callback(self, pct: float) -> None:
        if not self.enabled or self._current is None:
            return
        pct = max(0.0, min(100.0, float(pct)))
        self._current.last_progress_pct = pct
        now = time.monotonic()
        bucket = pct - (pct % self.progress_step_pct)
        should_print = (
            bucket > self._last_pct_bucket
            or now - self._last_progress_print >= self.progress_interval_sec
            or pct >= 100.0
        )
        if not should_print:
            return
        elapsed = now - self._current.started_at
        print(
            f"  [{self._current.name}] {pct:.0f}% | {elapsed:.0f}s elapsed",
            flush=True,
        )
        self._last_progress_print = now
        self._last_pct_bucket = bucket

    def callback_for_current_stage(self) -> Callable[[float], None] | None:
        if not self.enabled:
            return None
        return self.progress_callback

    def to_diagnostics(self) -> dict[str, Any]:
        finished = list(self.stages)
        if self._current is not None:
            finished = finished + [self._current]
        total = sum(s.elapsed_sec or 0.0 for s in finished)
        return {
            "file": self.file_label,
            "stages": [s.to_dict() for s in finished],
            "totalSeconds": round(total, 2),
        }

    def status_line(self) -> str:
        if self._current is None:
            if not self.stages:
                return "no active stage"
            last = self.stages[-1]
            return f"last stage={last.name} ({last.elapsed_sec}s)"
        elapsed = self._current.elapsed_sec or 0.0
        return (
            f"stage={self._current.name} device={self._current.device or 'n/a'} "
            f"progress={self._current.last_progress_pct:.0f}% elapsed={elapsed:.0f}s"
        )
