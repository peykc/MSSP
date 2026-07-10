#!/usr/bin/env bash
# MSSP Transcript Engine v2 - large-v3 PARALLEL pass (multi-GPU), Linux launcher
# for a rented GPU box. Mirrors transcribe_v2_parallel.bat.
#
# Usage:
#   ./run_parallel.sh                       # auto-detect all GPUs, one job each
#   ./run_parallel.sh --gpus 0,1,2,3        # explicit GPUs
#   ./run_parallel.sh --per-gpu 3 --gpus 0  # one big GPU, three concurrent jobs
#   ./run_parallel.sh --limit 10            # smoke test
# Extra args are passed straight through to transcribe_parallel.py / transcribe.py.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve a Python interpreter: prefer a venv next to (or above) this folder.
if [[ -x "$HERE/../.venv/bin/python" ]]; then
  PY="$HERE/../.venv/bin/python"
elif [[ -x "$HERE/.venv/bin/python" ]]; then
  PY="$HERE/.venv/bin/python"
else
  PY="python3"
  echo "No .venv found - using system python3. Run setup first (see RENTAL_RUNBOOK.md)."
fi

exec "$PY" "$HERE/transcribe_parallel.py" \
  --model large-v3 \
  --language en \
  --batch-size 8 \
  --output "$HERE/gen-large-v3" \
  --diarize \
  --speaker-mode adaptive \
  --reuse-cache \
  --reuse-align-model \
  --reuse-diarize-model \
  "$@"
