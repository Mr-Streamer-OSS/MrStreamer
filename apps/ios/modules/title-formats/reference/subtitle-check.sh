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
check_run=0
fail() {
  echo "FAIL $1"
  status=1
}

# Runs run.sh on one file with `options`, keeping its output in $log; 1 when it failed.
check() {
  local file=$1
  shift
  check_run=$((check_run + 1))
  log=$out/$(basename "$file").$check_run.log
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
# Whether rendition `$2` of the last run of file `$1` served the line `$3`, exactly.
serves() {
  grep -qxF "$3" "$out/runs/$(basename "$1")/$2"-*.vtt ||
    fail "$(basename "$1"): $2 serves no \"$3\""
}
subtitles() {
  local count
  count=$(grep -c "TYPE=SUBTITLES" "$out/runs/$(basename "$1")/main.m3u8" || true)
  [[ $count == "$2" ]] || fail "$(basename "$1"): $count subtitle renditions for $2"
}

subs=$fixtures/subs.mkv
if check "$subs"; then
  verify "$subs"
  # What the playlist says of each, as the fixture made them.
  master=$out/runs/subs.mkv/main.m3u8
  for line in \
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="eng 1",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="s0.m3u8"' \
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="eng 2",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES,URI="s1.m3u8"' \
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="fra 3",LANGUAGE="fra",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="s2.m3u8"' \
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="ger 4",LANGUAGE="ger",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="s3.m3u8"'; do
    grep -qxF "$line" "$master" || fail "subs.mkv: no $line"
  done
  grep -q '^#EXT-X-STREAM-INF:.*,SUBTITLES="subs"$' "$master" || fail "subs.mkv: no SUBTITLES group"
  # The forced English lines are in the regular English track too, and in no other.
  serves "$subs" s0 "FORCED SIGN"
  serves "$subs" s1 "FORCED SIGN"
  for other in s2 s3; do
    ! grep -qF "FORCED" "$out/runs/subs.mkv/$other"-*.vtt || fail "subs.mkv: $other holds a forced line"
  done
  # Text as WebVTT has it: tags kept, others gone, escapes, line breaks and a no-break space.
  serves "$subs" s0 "Over the <i>long</i> line"
  serves "$subs" s0 "<b>Bold</b> &amp; <u>under</u> red"
  serves "$subs" s0 "second row"
  serves "$subs" s0 "I &lt;3 you &gt; them"
  serves "$subs" s2 "<i>En italique</i>"
  serves "$subs" s2 "deuxième ligne"
  serves "$subs" s2 "Panneau long"
  serves "$subs" s2 $'Après un dessin\xc2\xa0ici'
  serves "$subs" s3 "Kurz <i>dazu</i>"
fi
for name in subs-reordered subs-badcues subs-drawing; do
  check "$fixtures/$name.mkv" && verify "$fixtures/$name.mkv"
done
# Encodings FFmpeg undoes stay served.
for name in subs-stripped subs-private; do
  check "$fixtures/$name.mkv" && verify "$fixtures/$name.mkv" && subtitles "$fixtures/$name.mkv" 4
done
# Dutch DVB pictures are named.
dvb=$fixtures/subs-dvb.mkv
check "$dvb" && verify "$dvb" && says "$dvb" "unshown: dut DVB"
# Past the 16 unshown tracks it names, the core counts the rest.
crowded=$fixtures/subs-crowded.mkv
if check "$crowded"; then
  named=$(grep -cxF "unshown: dut DVB" "$log" || true)
  [[ $named == 16 ]] || fail "subs-crowded.mkv: $named unshown tracks named for 16"
  says "$crowded" "unshown: 4 more"
fi
check "$fixtures/subs.mkv" --start 30 && verify "$fixtures/subs.mkv"
# A read failing from any point of a fresh segment's request on fails that request only: asked
# again, the segment holds the lines it would have.
if check "$subs" --faults; then
  grep -qE "^faults: [1-9][0-9]* reads failed, 0 segments differ when asked again$" "$log" ||
    fail "subs.mkv: no failed reads"
fi
check "$fixtures/subs-uncued.mkv" --uncued && verify "$fixtures/subs-uncued.mkv"
# The track marked compressed is named, not served; ffmpeg can't read these files' lines.
for name in subs-zlib:compressed subs-far:compressed subs-bzip2:compressed subs-twice:compressed \
  subs-encrypted:encrypted; do
  if check "$fixtures/${name%:*}.mkv"; then
    says "${name%:*}" "unshown: eng ${name#*:} text forced"
    subtitles "$fixtures/${name%:*}.mkv" 3
  fi
done
# Without its Tracks no text track's encoding is known: none is served, each is named.
hidden=$fixtures/subs-hidden.mkv
if check "$hidden"; then
  subtitles "$hidden" 0
  for line in "eng text of unknown encoding" "eng text of unknown encoding forced" \
    "fra text of unknown encoding" "ger text of unknown encoding"; do
    says "$hidden" "unshown: $line"
  done
fi
# Past 4 MB of a track's lines, read in order, its segments say so; a seek may first find the
# few lines it reads, so fresh seeks may differ.
many=$fixtures/subs-many.mkv
check "$many" --uncued && serves "$many" s0 "These subtitles are too large to show."
check "$fixtures/subs-huge.mkv" && serves "$fixtures/subs-huge.mkv" s0 "This line is too large to show."
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
