#!/bin/sh
set -u
reward=0
finish() {
  mkdir -p /logs/verifier 2>/dev/null || true
  printf '%s\n' "$reward" > /logs/verifier/reward.txt
}
trap finish EXIT HUP INT TERM
mkdir -p /logs/verifier
if pytest -q /tests/test_verify.py --ctrf=/logs/verifier/ctrf.json; then
  reward=1
fi
[ "$reward" -eq 1 ]
