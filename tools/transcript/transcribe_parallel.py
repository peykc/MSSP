#!/usr/bin/env python3
"""Parallel launcher for MSSP transcription across one or more GPUs.

This is the throughput-oriented sibling of --isolate-per-file, meant for a
rented multi-GPU box. It combines all three speedups:

  * Multi-GPU  — one worker per GPU pulls from a shared queue (work-stealing),
    so uneven episode lengths never leave a GPU idle at the tail of the run.
    Each worker pins its jobs to its physical GPU via CUDA_VISIBLE_DEVICES;
    transcribe.py always uses device index 0, so the child sees exactly that
    GPU as cuda:0 and needs no changes.
  * Model reuse — a worker hands transcribe.py a *chunk* of episodes at once
    (via --only-list), so the large-v3 / alignment / diarization models load
    once and are reused across the whole chunk instead of reloading per file.
    The process still recycles between chunks, which bounds the CUDA memory
    growth that --isolate-per-file was built to avoid on tiny GPUs.
  * Batch size — passed straight through to transcribe.py (--batch-size), the
    parallelism *inside* a single transcription. See the launchers.

Episodes whose output JSON already exists are skipped, so an interrupted or
re-rented run resumes for free.

Usage (extra args after the known flags pass through to transcribe.py):
  python transcribe_parallel.py --model large-v3 --batch-size 8 --diarize \
      --reuse-align-model --reuse-diarize-model --output ./gen-large-v3
  python transcribe_parallel.py --gpus 0,1,2,3               # explicit GPUs
  python transcribe_parallel.py --files-per-worker 4         # smaller chunks
  python transcribe_parallel.py --files-per-worker 1         # one process per file
  python transcribe_parallel.py --limit 10 --dry-run
"""

from __future__ import annotations

import argparse
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

# transcribe.py imports torch lazily (only inside functions), so importing it
# here is cheap and side-effect free — it just gives us the exact same file
# discovery / filtering / output-path logic the sequential runner uses.
from transcribe import (
    DEFAULT_INPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    apply_file_filters,
    discover_audio_files,
    parse_extensions,
    transcript_output_path,
)

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_EXTENSIONS = ".mp3,.m4a,.mp4,.wav,.flac,.aac,.ogg,.opus"


def detect_gpus() -> list[str]:
    """Return physical GPU ids via nvidia-smi, without importing torch."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    return [line.strip() for line in out.stdout.splitlines() if line.strip() != ""]


def parse_known(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(
        description="Run MSSP transcription in parallel across GPUs.",
        add_help=True,
    )
    parser.add_argument("-i", "--input", type=Path, default=DEFAULT_INPUT_DIR,
                        help="Audio folder (default: parent of tools/transcript)")
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT_DIR,
                        help="Transcript JSON folder (default: ./gen/)")
    parser.add_argument("--gpus", default=None,
                        help="Comma-separated physical GPU ids (default: auto-detect all)")
    parser.add_argument("--per-gpu", type=int, default=1,
                        help="Concurrent worker processes per GPU (each holds its own "
                             "resident models; raise to 2 only on big-VRAM cards)")
    parser.add_argument("--files-per-worker", type=int, default=8,
                        help="Episodes per worker process. >1 keeps the align/diarize "
                             "models resident and reused across that chunk (big speedup); "
                             "the process still recycles between chunks to bound CUDA "
                             "memory growth. Set 1 for strict one-process-per-episode.")
    parser.add_argument("--recursive", action="store_true", help="Scan subdirectories for audio")
    parser.add_argument("--preserve-folders", action="store_true",
                        help="Mirror input subfolder structure under output")
    parser.add_argument("--extensions", default=DEFAULT_EXTENSIONS,
                        help="Comma-separated audio extensions")
    parser.add_argument("--limit", type=int, default=None, help="Process at most N files")
    parser.add_argument("--start-after", default=None, help="Skip until after this exact filename")
    parser.add_argument("--only", default=None, help="Process only this exact filename")
    parser.add_argument("--retries", type=int, default=1,
                        help="Individual re-attempts for a failed episode before giving up")
    parser.add_argument("--force", action="store_true",
                        help="Re-transcribe even if the output JSON already exists")
    parser.add_argument("--dry-run", action="store_true",
                        help="List the work plan and exit without transcribing")
    # Everything else (model, batch-size, diarize, speaker-mode, reuse-*, row-*,
    # force-*, etc.) is passed straight through to transcribe.py.
    return parser.parse_known_args(argv)


class Runner:
    def __init__(self, args: argparse.Namespace, passthrough: list[str],
                 files: list[Path]) -> None:
        self.args = args
        self.passthrough = passthrough
        self.input_dir = args.input.resolve()
        self.output_dir = args.output.resolve()
        self.queue: "queue.Queue[Path]" = queue.Queue()
        for path in files:
            self.queue.put(path)
        self.total = len(files)
        self.lock = threading.Lock()
        self.done = 0
        self.processed = 0
        self.failed: list[str] = []
        self.chunk_seq = 0
        self.log_dir = self.output_dir / "_parallel-logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _output_exists(self, source_path: Path) -> bool:
        out_path = transcript_output_path(source_path, self.input_dir, self.output_dir,
                                          self.args.preserve_folders)
        return out_path.exists()

    def _next_chunk_id(self) -> int:
        with self.lock:
            self.chunk_seq += 1
            return self.chunk_seq

    def _run_list(self, gpu: str, chunk: list[Path], label: str) -> None:
        """Run one transcribe.py process over `chunk` pinned to `gpu`."""
        list_path = self.log_dir / f"{label}.txt"
        log_path = self.log_dir / f"{label}.log"
        list_path.write_text("\n".join(p.name for p in chunk) + "\n", encoding="utf-8")

        cmd = [
            sys.executable, str(SCRIPT_DIR / "transcribe.py"),
            "--input", str(self.args.input),
            "--output", str(self.args.output),
            "--only-list", str(list_path),
        ]
        if self.args.recursive:
            cmd.append("--recursive")
        if self.args.preserve_folders:
            cmd.append("--preserve-folders")
        if self.args.force:
            cmd.append("--force")
        # --isolate-per-file is intentionally omitted: this launcher IS the
        # isolation layer, and we WANT one process to keep models resident
        # across the chunk. Reuse flags come through the passthrough.
        cmd.extend(self.passthrough)

        env = os.environ.copy()
        env["CUDA_VISIBLE_DEVICES"] = gpu
        with open(log_path, "w", encoding="utf-8", errors="replace") as log_file:
            subprocess.run(cmd, env=env, stdout=log_file, stderr=subprocess.STDOUT)
        # Success is judged per file by output existence (robust even though one
        # process handles many files). In the normal resume flow only
        # not-yet-transcribed files are queued, so this is exact.

    def _process_chunk(self, gpu: str, chunk: list[Path]) -> None:
        chunk_id = self._next_chunk_id()
        names = ", ".join(p.stem for p in chunk[:3]) + ("…" if len(chunk) > 3 else "")
        print(f"[gpu {gpu}] chunk {chunk_id} ({len(chunk)} eps): {names}", flush=True)
        start = time.monotonic()
        self._run_list(gpu, chunk, f"chunk-gpu{gpu}-{chunk_id:04d}")

        # Retry any episode whose transcript did not appear, individually.
        misses = [p for p in chunk if not self._output_exists(p)]
        for source_path in misses:
            ok = False
            for attempt in range(1, self.args.retries + 1):
                print(f"[gpu {gpu}] retry {attempt}: {source_path.name}", file=sys.stderr, flush=True)
                self._run_list(gpu, [source_path], f"retry-gpu{gpu}-{self._next_chunk_id():04d}")
                if self._output_exists(source_path):
                    ok = True
                    break
            if not ok:
                with self.lock:
                    self.failed.append(source_path.name)

        elapsed = time.monotonic() - start
        succeeded = [p for p in chunk if self._output_exists(p)]
        with self.lock:
            self.processed += len(succeeded)
            self.done += len(chunk)
            done, total = self.done, self.total
        print(f"[gpu {gpu}] chunk {chunk_id} done ({elapsed / 60:.1f} min, "
              f"{len(succeeded)}/{len(chunk)} ok) — {done}/{total} episodes", flush=True)

    def _take_chunk(self) -> list[Path]:
        chunk: list[Path] = []
        for _ in range(max(1, self.args.files_per_worker)):
            try:
                chunk.append(self.queue.get_nowait())
            except queue.Empty:
                break
        return chunk

    def _worker(self, gpu: str) -> None:
        while True:
            chunk = self._take_chunk()
            if not chunk:
                return
            self._process_chunk(gpu, chunk)

    def _drain(self) -> None:
        try:
            while True:
                self.queue.get_nowait()
        except queue.Empty:
            pass

    def run(self, slots: list[str]) -> int:
        threads = [threading.Thread(target=self._worker, args=(gpu,), daemon=True)
                   for gpu in slots]
        start = time.monotonic()
        for thread in threads:
            thread.start()
        try:
            while any(t.is_alive() for t in threads):
                for thread in threads:
                    thread.join(timeout=0.5)
        except KeyboardInterrupt:
            print("\nInterrupted — draining queue; in-flight chunks will finish.",
                  file=sys.stderr)
            self._drain()
            for thread in threads:
                thread.join()
        elapsed = time.monotonic() - start
        print("\nParallel run summary:")
        print(f"  slots:     {len(slots)} ({','.join(slots)})")
        print(f"  processed: {self.processed}")
        print(f"  failed:    {len(self.failed)}")
        print(f"  wall time: {elapsed / 60:.1f} min")
        if self.failed:
            print("  failed episodes (see _parallel-logs/*.log):")
            for name in self.failed:
                print(f"    - {name}")
        return 1 if self.failed else 0


def main() -> int:
    args, passthrough = parse_known(sys.argv[1:])

    gpu_ids = ([g.strip() for g in args.gpus.split(",") if g.strip() != ""]
               if args.gpus else detect_gpus())
    if not gpu_ids:
        print("ERROR: no GPUs found. Pass --gpus 0 (or the ids to use), or run on "
              "a CUDA box. For CPU-only testing use transcribe.py directly.",
              file=sys.stderr)
        return 2
    slots = [gpu for gpu in gpu_ids for _ in range(max(1, args.per_gpu))]

    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    extensions = parse_extensions(args.extensions)

    all_files = discover_audio_files(input_dir, extensions, args.recursive)
    files = apply_file_filters(all_files, args.start_after, args.limit,
                               test=False, only=args.only)

    if not args.force:
        pending = []
        skipped = 0
        for source_path in files:
            out_path = transcript_output_path(source_path, input_dir, output_dir,
                                              args.preserve_folders)
            if out_path.exists():
                skipped += 1
            else:
                pending.append(source_path)
        files = pending
    else:
        skipped = 0

    print("MSSP parallel transcription")
    print(f"  input:   {input_dir}")
    print(f"  output:  {output_dir}")
    print(f"  GPUs:    {','.join(gpu_ids)}  (per-gpu {args.per_gpu} -> {len(slots)} slots)")
    print(f"  chunk:   {max(1, args.files_per_worker)} episodes/process (models reused within a chunk)")
    print(f"  found:   {len(all_files)} audio file(s)")
    print(f"  skipped: {skipped} (transcript already exists)")
    print(f"  queued:  {len(files)}")
    if passthrough:
        print(f"  passthrough to transcribe.py: {' '.join(passthrough)}")

    if not files:
        print("Nothing to do.")
        return 0
    if args.dry_run:
        print("\nDry run — first 10 queued:")
        for source_path in files[:10]:
            print(f"    {source_path.name}")
        return 0

    return Runner(args, passthrough, files).run(slots)


if __name__ == "__main__":
    sys.exit(main())
