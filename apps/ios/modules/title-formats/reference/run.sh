#!/usr/bin/env bash
# Builds the reference check against vendor/ffmpeg/reference and runs it on each file given:
#   modules/title-formats/reference/run.sh <out-folder> <file>...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ff=$here/../../../vendor/ffmpeg/reference/prefix
out=${1:?usage: run.sh <out-folder> <file>...}
shift
mkdir -p "$out"
cc -std=c11 -O1 -g -Wall -Wextra -Wno-unused-parameter -I"$ff/include" "$here/check.c" \
  "$here/../ios/core/title_hls.c" -L"$ff/lib" -Wl,-rpath,"$ff/lib" -lavformat -lavcodec -lavutil \
  -lm -o "$out/check"
for file in "$@"; do
  name=$(basename "$file")
  rm -rf "${out:?}/$name"
  mkdir -p "$out/$name"
  echo "== $name"
  "$out/check" "$file" "$out/$name" || echo "FAILED $name"
done
