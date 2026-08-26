#!/usr/bin/env bash
# Wrapper for the scheduler: fixed working directory, rotating log, no surprises.
set -uo pipefail
cd "$(dirname "$0")"

mkdir -p logs
LOG=logs/checker.log
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ] && mv "$LOG" "$LOG.1"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node check.js "$@" >> "$LOG" 2>&1
code=$?
[ $code -eq 10 ] && echo "APPOINTMENT FOUND - see $LOG" >> "$LOG"
exit $code
