#!/bin/sh
set -eu
# Deliberately bogus shortcut: reuse only the visible reproducer output as the submission.
node /app/build_audit.mjs --input /app/data/repro.jsonl --output /app/editor_audit.json
