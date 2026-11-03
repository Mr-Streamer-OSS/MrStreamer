#!/usr/bin/env bash
# Public FLAC admission, gap and copy checks. Scratch stays in the supplied folder.
# FLAC_CHECK_BINARY optionally runs a deliberately broken checker for negative controls.
# Usage: flac-check.sh <out-folder>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: flac-check.sh <out-folder>}
mkdir -p "$out"
"$here/flac-fixtures.sh" "$out/fixtures" >"$out/fixtures.log" 2>&1
"$here/run.sh" "$out/build" "$out/fixtures/picture.mkv" >"$out/build.log" 2>&1
checker=${FLAC_CHECK_BINARY:-$out/build/check}
status=0
fail() { echo "FAIL $1"; status=1; }
for start in 0 7.3; do
  for file in "$out/fixtures/"*.mkv; do
    name=$(basename "$file" .mkv)
    # These controls isolate picture-only admission after the short sound track ends.
    if [[ $start == 0 && ( $name == late-corrupt || $name == late-source ) ]]; then continue; fi
    folder=$out/start-$start/$name
    rm -rf "${folder:?}"
    mkdir -p "$folder"
    log=$folder/check.log
    code=0
    CHECK_FAULTS=1 "$checker" "$file" "$folder" "$start" >"$log" 2>&1 || code=$?
    if grep -Eq 'runtime error|ERROR: AddressSanitizer' "$log"; then fail "$name: sanitizer"; fi
    reason= segments=
    case $name in
      tiny-block) reason="Its FLAC frames are too short for the track's clock." ;;
      invalid-lead) reason='Its FLAC sound has too many invalid frames in a row.' ;;
      track-rate|track-channels) reason='Its FLAC track disagrees with STREAMINFO.' ;;
      surround) reason='Its FLAC sound has more than two channels.' ;;
      rate96) reason="Its FLAC sound isn't 44.1 or 48 kHz." ;;
      variable-info) reason='Its FLAC sound has frames of more than one length.' ;;
      variable-strategy) reason="Its FLAC sound has frames this can't play." ;;
      crc8-only|channel-assignment|zero-rate|overlong-number) segments=1 ;;
      corrupt-middle) segments=2 ;;
      length-change) segments='2 3 4' ;;
    esac
    if [[ -n $reason ]]; then
      [[ $code == 1 ]] || fail "$name: expected open refusal, exit $code"
      [[ $(sed -n 's/^open .* result=2 .*detail=//p' "$log") == "$reason" ]] || fail "$name: wrong open refusal"
    else
      [[ $code == 0 ]] || fail "$name: checker exit $code"
      actual=$(sed -n "s/^a0-\([0-9]*\)\.m4s refused: Its sound has a gap here that can't be played\.$/\1/p" "$log" | sort -nu | paste -sd ' ')
      [[ $actual == "$segments" ]] || fail "$name: refused segments '$actual', expected '$segments'"
      # Every refusal must have the exact expected gap reason and segment name.
      if grep 'refused:' "$log" | grep -vE "^a0-[0-9]+\.m4s refused: Its sound has a gap here that can't be played\.$"; then
        fail "$name: unexpected refusal"
      fi
      if [[ -z $segments ]]; then
        python3 -I "$here/verify.py" "$file" "$folder" >"$folder/verify.log" 2>&1 || fail "$name: verify.py"
      fi
      if [[ $name == late-corrupt || $name == late-source ]]; then
        ! grep -q 'TYPE=AUDIO' "$folder/main.m3u8" || fail "$name: late sound offered"
      fi
    fi
  done
done
[[ $status == 0 ]] && echo 'FLAC checks passed (faults, start 0 and 7.3).'
exit "$status"
