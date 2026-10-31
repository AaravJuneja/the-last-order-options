#!/usr/bin/env bash
set -euo pipefail
export BUILD_ID="$(date +%s)"
bun run typecheck
bash scripts/build.sh
wrangler deploy --var "BUILD_ID:$BUILD_ID"
