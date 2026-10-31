#!/usr/bin/env bash
# Checks the core's subtitles on the files subtitle-fixtures.sh makes and the desktop's picture
# subtitle clip, each with what it must show: run.sh's checks, verify.py against the source, and
# for the files verify.py can't judge, what the stream must name or say. Fails on any miss:
#   modules/title-formats/reference/subtitle-check.sh <out-folder>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: subtitle-check.sh <out-folder>}
fixtures=$out/fixtures
"$here/subtitle-fixtures.sh" "$fixtures"
status=0
fail() {
  echo "FAIL $1"
  status=1
}

# Runs run.sh on one file with `options`, keeping its output in $log; 1 when it failed.
check() {
  local file=$1
  shift
  log=$out/$(basename "$file").log
  "$here/run.sh" "$out/runs" "$@" "$file" >"$log" 2>&1 || {
    fail "$(basename "$file"): run.sh, see $log"
    return 1
  }
  # UndefinedBehaviorSanitizer reports and goes on.
  if grep -q "runtime error" "$log"; then
    fail "$(basename "$file"): a sanitizer report, see $log"
    return 1
  fi
}
verify() {
  python3 -I "$here/verify.py" "$1" "$out/runs/$(basename "$1")" >>"$log" 2>&1 ||
    fail "$(basename "$1"): verify.py, see $log"
}
# Whether run.sh printed exactly `line`.
says() { grep -qxF "$2" "$log" || fail "$(basename "$1"): no \"$2\""; }
subtitles() {
  local count
  count=$(grep -c "TYPE=SUBTITLES" "$out/runs/$(basename "$1")/main.m3u8" || true)
  [[ $count == "$2" ]] || fail "$(basename "$1"): $count subtitle renditions for $2"
}

for name in subs subs-reordered subs-badcues subs-drawing; do
  check "$fixtures/$name.mkv" && verify "$fixtures/$name.mkv"
done
check "$fixtures/subs.mkv" --start 30 && verify "$fixtures/subs.mkv"
check "$fixtures/subs-uncued.mkv" --uncued && verify "$fixtures/subs-uncued.mkv"
# The track marked compressed is named, not served; ffmpeg can't read these files' lines.
for name in subs-zlib subs-far; do
  if check "$fixtures/$name.mkv"; then
    says "$name" "unshown: eng compressed text forced"
    subtitles "$fixtures/$name.mkv" 3
  fi
done
long=$fixtures/subs-longline.mkv
if check "$long"; then
  served=$(cat "$out/runs/subs-longline.mkv"/s0-*.vtt)
  for line in Before "This line is too large to show." After; do
    grep -qxF "$line" <<<"$served" || fail "subs-longline.mkv: no \"$line\""
  done
fi
pictures=$here/../../../../desktop/test/fixtures/title-h264-picture-subs.mkv
if check "$pictures"; then
  says "$pictures" "unshown: eng PGS"
  says "$pictures" "unshown: nld DVD forced"
  verify "$pictures"
fi
[[ $status == 0 ]] && echo "subtitle checks pass"
exit $status
