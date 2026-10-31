#!/usr/bin/env bash
set -euo pipefail
BUILD_ID="${BUILD_ID:-dev}"
rm -rf dist
bun build ./index.html ./revolutionize.html --outdir=dist --minify --define "BUILD_ID=\"$BUILD_ID\""
cp public/_headers dist/
