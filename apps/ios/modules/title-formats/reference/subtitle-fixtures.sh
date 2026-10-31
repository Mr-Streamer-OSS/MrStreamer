#!/usr/bin/env bash
# Makes the synthetic Matroska files the subtitle checks read, into a folder, with ffmpeg's own
# test sources and subtitles written here; nothing comes from a broadcast or a provider:
#   modules/title-formats/reference/subtitle-fixtures.sh <out-folder>
#
# - subs.mkv: a minute of H.264 (a keyframe every 2 s) with AAC, and text subtitles whose lines
#   outlast several segments: English SubRip with a 35-second line and lines over it and tags,
#   forced English SubRip, French ASS with italics, overrides and a drawing, and German WebVTT.
#   ffmpeg stores each subtitle up to 10 s ahead of its time, and its index
#   lists every subtitle line with its length.
# - subs-uncued.mkv: the same file with every subtitle line left out of its index, each entry
#   overwritten by a Void element of its size, so nothing else moves.
# Needs an ffmpeg with libx264 and its AAC encoder on PATH, as Ubuntu's and Homebrew's builds have.
set -euo pipefail
out=${1:?usage: subtitle-fixtures.sh <out-folder>}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/english.srt" <<'SRT'
1
00:00:01,000 --> 00:00:03,000
First line

2
00:00:10,000 --> 00:00:45,000
A line on screen for thirty-five seconds

3
00:00:12,000 --> 00:00:14,000
Over the <i>long</i> line

4
00:00:50,000 --> 00:00:52,000
<b>Bold</b> & <u>under</u> <font color="red">red</font>
second row
SRT
cat >"$work/forced.srt" <<'SRT'
1
00:00:20,000 --> 00:00:22,000
FORCED SIGN

2
00:00:30,000 --> 00:00:41,000
FORCED SIGN OVER THE LONG LINE
SRT
cat >"$work/french.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:40.00,Default,,0,0,0,,{\pos(160,20)}Panneau long
Dialogue: 0,0:00:08.00,0:00:11.00,Default,,0,0,0,,{\i1}En italique{\i0}\Ndeuxième ligne
Dialogue: 0,0:00:24.00,0:00:26.00,Default,,0,0,0,,{\p1}m 0 0 l 10 0 10 10{\p0}Après un dessin\hici
ASS
cat >"$work/german.vtt" <<'VTT'
WEBVTT

00:00:15.000 --> 00:00:50.000
Lange Zeile oben

00:00:33.000 --> 00:00:35.000
Kurz <i>dazu</i>
VTT

ffmpeg -v error -y \
  -f lavfi -i "testsrc=size=320x180:rate=25" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -i "$work/english.srt" -i "$work/forced.srt" -i "$work/french.ass" -i "$work/german.vtt" \
  -map 0:v -map 1:a -map 2 -map 3 -map 4 -map 5 -t 60 \
  -c:v libx264 -preset veryfast -g 50 -keyint_min 50 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -c:s:0 srt -c:s:1 srt -c:s:2 ass -c:s:3 webvtt \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=eng -metadata:s:s:2 language=fra \
  -metadata:s:s:3 language=ger -disposition:s:0 0 -disposition:s:1 forced \
  -disposition:s:2 0 -disposition:s:3 0 -fflags +bitexact "$out/subs.mkv"

# The subtitle tracks are the file's third to sixth.
python3 -I - "$out/subs.mkv" "$out/subs-uncued.mkv" 3 4 5 6 <<'PY'
import sys
source, target, *tracks = sys.argv[1:]
tracks = {int(t) for t in tracks}
b = bytearray(open(source, "rb").read())
def vint(o, keep=False):
    n = 1
    while not b[o] & (0x80 >> (n - 1)): n += 1
    v = b[o] if keep else b[o] & (0xFF >> n)
    for i in range(1, n): v = v << 8 | b[o + i]
    return v, n
def elements(o, e):
    while o < e:
        i, n = vint(o, True); s, m = vint(o + n)
        yield i, o, n, o + n + m, o + n + m + s; o = o + n + m + s
voided = 0
for i, _, _, s, e in elements(0, len(b)):
    if i != 0x18538067: continue
    for i2, _, _, s2, e2 in elements(s, e):
        if i2 != 0x1C53BB6B: continue
        for i3, _, _, s3, e3 in elements(s2, e2):
            for i4, at, n, s4, e4 in elements(s3, e3):
                if i4 != 0xB7: continue
                track = next(int.from_bytes(b[s5:e5], "big") for i5, _, _, s5, e5 in elements(s4, e4) if i5 == 0xF7)
                if track in tracks:
                    b[at] = 0xEC  # a Void element, its size as it was
                    b[s4:e4] = bytes(e4 - s4)
                    voided += 1
open(target, "wb").write(b)
print(f"{target}: {voided} subtitle index entries left out")
PY
