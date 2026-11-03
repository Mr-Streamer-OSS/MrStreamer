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
python3 -I "$here/flac-fixtures.py" "$out"
