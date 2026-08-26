#!/usr/bin/env bash
# End-to-end test of the wizard walker against test/mock-icp.js.
# Expects: oficina A -> no slots, oficina C -> appointment found (exit 10).
set -uo pipefail
cd "$(dirname "$0")/.."

node test/mock-icp.js 8099 & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1

rm -f state.json
export ICP_BASE_URL=http://127.0.0.1:8099/icpplus
export ICP_NIE=TEST0000X ICP_NOMBRE="Test User" ICP_DELAY_MS=200
export SMTP_USER= SMTP_PASS= MAIL_TO=
export NO_PROXY="${NO_PROXY:-},127.0.0.1"

node check.js --force
code=$?
rm -f state.json
[ $code -eq 10 ] && { echo "PASS - appointment detected as expected"; exit 0; }
echo "FAIL - expected exit code 10, got $code"; exit 1
