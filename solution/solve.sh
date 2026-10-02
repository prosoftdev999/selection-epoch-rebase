#!/bin/sh
set -eu
cp /solution/build_audit.mjs /app/reference_legacy.mjs
cp /solution/build_rebase.mjs /app/reference_rebase.mjs
cp /solution/combine.mjs /app/reference_combine.mjs
node /app/reference_legacy.mjs --input /app/data/capture.jsonl --output /app/legacy_audit.json
node /app/reference_rebase.mjs --input /app/data/rebase_capture.jsonl --output /app/rebase_audit.json
node /app/reference_combine.mjs
rm -f /app/legacy_audit.json /app/rebase_audit.json /app/reference_legacy.mjs /app/reference_rebase.mjs /app/reference_combine.mjs
