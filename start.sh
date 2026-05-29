#!/bin/bash
# Auto-restart wrapper for the kicialite bot. Survives silent crashes
# (native segfault, OOM kill, anything that bypasses nodemon's own
# restart-on-file-change). --exitcrash makes nodemon exit on child crash
# instead of waiting for a file change; the outer loop respawns.
cd "$(dirname "$0")" || exit 1
while true; do
  echo "[wrapper] starting at $(date -u +%FT%TZ)"
  nodemon --exitcrash src/index.js
  ec=$?
  echo "[wrapper] nodemon exited code=$ec at $(date -u +%FT%TZ) (restarting in 3s)"
  sleep 3
done
