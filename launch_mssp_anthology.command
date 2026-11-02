#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
fail() { printf '\n%s\n' "$1"; read -r -p 'Press Return to close…' _; exit 1; }
NODE_EXE="${NODE_EXE:-}"
if [ -z "$NODE_EXE" ]; then
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [ -x "$candidate" ] && "$candidate" -e 'require("node:sqlite")' >/dev/null 2>&1; then
      NODE_EXE="$candidate"
      break
    fi
  done
fi
[ -n "$NODE_EXE" ] || fail 'MSSP needs Node.js 22.13 or newer. Install a current Node.js LTS from nodejs.org, then try again.'
"$NODE_EXE" -e 'require("node:sqlite")' >/dev/null 2>&1 || fail 'This Node.js version does not support node:sqlite. Install a current Node.js LTS.'
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-5177}"
URL="http://127.0.0.1:$PORT"
if /usr/bin/curl -fsS "$URL/api/health" 2>/dev/null | "$NODE_EXE" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.exit(h.sourceFile?0:1)}catch{process.exit(1)}})'; then
  /usr/bin/open "$URL"
  exit 0
fi
"$NODE_EXE" mssp_app/server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM
for ((attempt=0; attempt<100; attempt++)); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail 'The MSSP server could not start. See the error above.'
  if /usr/bin/curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    /usr/bin/open "$URL"
    printf '\nMSSP is running at %s\nKeep this window open. Press Control-C to stop.\n' "$URL"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.1
done
fail 'The MSSP server did not become ready. See the errors above.'
