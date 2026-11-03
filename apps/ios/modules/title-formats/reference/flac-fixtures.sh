#!/usr/bin/env bash
# Synthetic FLAC title fixtures, made only from ffmpeg's testsrc2 and sine sources.
# Usage: flac-fixtures.sh <out-folder>. All intermediates stay in that folder.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: flac-fixtures.sh <out-folder>}
mkdir -p "$out"
ffmpeg -v error -y -f lavfi -i 'testsrc2=size=160x90:rate=25:duration=20' \
  -c:v libx264 -preset ultrafast -g 50 -keyint_min 50 -sc_threshold 0 -an "$out/picture.mkv"
flac() {
  local name=$1 rate=$2 channels=$3 format=$4 block=$5
  ffmpeg -v error -y -i "$out/picture.mkv" -f lavfi -i "sine=frequency=440:sample_rate=$rate:duration=20" \
    -map 0:v -map 1:a -c:v copy -c:a flac -ac "$channels" -sample_fmt "$format" \
    -frame_size "$block" "$out/$name.mkv"
}
flac stereo16 48000 2 s16 4608
flac stereo24 44100 2 s32 4608
flac mono 48000 1 s16 4608
flac block4096 48000 2 s16 4096
flac surround 48000 6 s16 4608
flac rate96 96000 2 s16 4608
ffmpeg -v error -y -i "$out/stereo16.mkv" -map 0:v -map 0:a -map 0:a \
  -c:v copy -c:a:0 aac -c:a:1 copy "$out/aac-flac.mkv"
flac tiny-block 48000 2 s16 16
# One 44.1 kHz frame is longer than EDGE_S; ending 50 ms early must still serve.
ffmpeg -v error -y -i "$out/picture.mkv" -f lavfi -i 'sine=sample_rate=44100:duration=19.95' \
  -map 0:v -map 1:a -c:v copy -c:a flac -frame_size 4608 "$out/early-end.mkv"
# More than 1024 invalid packets precede the picture's first keyframe.
ffmpeg -v error -y -itsoffset 12 -i "$out/picture.mkv" -f lavfi -i 'sine=sample_rate=48000:duration=32' \
  -map 0:v -map 1:a -c:v copy -c:a flac -frame_size 192 "$out/lead-source.mkv"
# Opening later has no nearby sound, but the lead held valid frames as well as one bad one.
ffmpeg -v error -y -itsoffset 0.2 -i "$out/picture.mkv" -f lavfi -i 'sine=sample_rate=48000:duration=1' \
  -map 0:v -map 1:a -c:v copy -c:a flac -ac 2 -frame_size 4608 "$out/late-source.mkv"
python3 -I "$here/flac-fixtures.py" "$out"
