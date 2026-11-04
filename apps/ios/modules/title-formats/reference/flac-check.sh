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
    # The focused recall check below requests this line without reading the corrupt segment.
    if [[ $name == recall-* ]]; then continue; fi
    if [[ $start == 0 && $name == resume-corrupt ]]; then continue; fi
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
      tiny-block) reason="Its FLAC sound has frames too short to time." ;;
      invalid-lead|alternating-lead) reason='Its FLAC sound has too many invalid frames.' ;;
      track-rate|track-channels) reason='Its FLAC sound has conflicting format details.' ;;
      resume-corrupt) reason="Its FLAC sound has frames this can't play." ;;
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
      [[ $(sed -n "s/^open .* result=2 .*detail=//p" "$log") == "$reason" ]] || fail "$name: wrong open refusal"
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
# Check whole decoded sound without -t/-to, including the last frame. FFmpeg decodes FLAC
# independently of MP4 sample durations, so also compare those durations to decoded lengths:
# Apple decoders can pad a short last frame when its MP4 duration overstates its length.
python3 -I - "$out" <<'PYEND' || fail 'FLAC whole sound and frame durations'
import json
from pathlib import Path
import subprocess
import sys

out = Path(sys.argv[1])
ok = True
for name in ('stereo16', 'stereo24', 'mono', 'block4096', 'corrupt-last'):
    folder = out / 'start-0' / name
    joined = folder / 'whole.mp4'
    segments = sorted(folder.glob('a0-*.m4s'), key=lambda p: int(p.stem.split('-')[-1]))
    joined.write_bytes((folder / 'a0.mp4').read_bytes() + b''.join(p.read_bytes() for p in segments))
    try:
        pcm = []
        for kind, path in (('source', out / 'fixtures' / (name + '.mkv')), ('served', joined)):
            run = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:a:0',
                                  '-c:a', 'pcm_f32le', '-f', 'f32le', '-'], capture_output=True, check=True)
            (folder / (kind + '-decode.log')).write_bytes(run.stderr)
            pcm.append(run.stdout)
        probe = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_frames',
            '-show_entries', 'packet=duration:frame=nb_samples', '-of', 'json', str(joined)]))
        entries = probe['packets_and_frames']
        durations = [p['duration'] for p in entries if p['type'] == 'packet']
        lengths = [f['nb_samples'] for f in entries if f['type'] == 'frame']
        same = pcm[0] == pcm[1]
        timed = bool(lengths) and durations == lengths
        ok &= same and timed
        print(f'{name}: source={len(pcm[0])} served={len(pcm[1])} PCM bytes, '
              f'identical={same}, extra bytes={len(pcm[1]) - len(pcm[0])}, '
              f'last duration={durations[-1]} samples={lengths[-1]}, all durations exact={timed}')
    finally:
        joined.unlink()
sys.exit(0 if ok else 1)
PYEND
# Prepare the later picture segment, fail indexed recall twice, then compare repaired text
# with a fresh good session. No later segment read may mask a swallowed recall failure.
ff=$here/../../../vendor/ffmpeg/reference/prefix
core=${FLAC_CHECK_CORE:-$here/../ios/core/title_hls.c}
cc -std=c11 -O1 -g -fsanitize=address,undefined -I"$ff/include" \
  "$here/flac-retry.c" "$core" -L"$ff/lib" -Wl,-rpath,"$ff/lib" \
  -lavformat -lavcodec -lavutil -lm -o "$out/flac-retry"
"$out/flac-retry" "$out/fixtures/recall-corrupt.mkv" "$out/fixtures/recall-source.mkv" \
  >"$out/recall.log" 2>&1 || fail 'indexed subtitle: FLAC failure and recovery'
[[ $status == 0 ]] && echo 'FLAC checks passed (faults, start 0 and 7.3).'
exit "$status"
