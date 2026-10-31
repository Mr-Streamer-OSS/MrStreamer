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
# - subs-reordered.mkv: the same with the regular and forced English tracks' entries in the other
#   order, so streams aren't in the order of their track numbers.
# - subs-zlib.mkv: the same with the forced English track marked as zlib-compressed, its lines
#   left as they are. An ffmpeg with zlib can't read them, so verify.py doesn't check this one;
#   its picture and sound are those of subs.mkv.
# - subs-badcues.mkv: the same with the index's last field running past the end of the index.
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
python3 -I - "$out" <<'PY'
import sys
out = sys.argv[1]
source = bytearray(open(f"{out}/subs.mkv", "rb").read())

def vint(b, o, keep=False):
    n = 1
    while not b[o] & (0x80 >> (n - 1)): n += 1
    v = b[o] if keep else b[o] & (0xFF >> n)
    for i in range(1, n): v = v << 8 | b[o + i]
    return v, n

def elements(b, o, e):
    """(id, start, header length, data start, end) of each element from o to e."""
    while o < e:
        i, n = vint(b, o, True); s, m = vint(b, o + n)
        yield i, o, n + m, o + n + m, o + n + m + s; o = o + n + m + s

def segment(b):
    return next(e for e in elements(b, 0, len(b)) if e[0] == 0x18538067)

def top(b, wanted):
    _, _, _, s, e = segment(b)
    return next(x for x in elements(b, s, e) if x[0] == wanted)

def entries(b):
    _, _, _, s, e = top(b, 0x1654AE6B)
    return [x for x in elements(b, s, e) if x[0] == 0xAE]

def number(b, entry):
    _, _, _, s, e = entry
    return next(int.from_bytes(b[s2:e2], "big") for i, _, _, s2, e2 in elements(b, s, e) if i == 0xD7)

# subs-uncued.mkv: every subtitle entry of the index overwritten by a Void element of its size.
b = bytearray(source)
_, _, _, s, e = top(b, 0x1C53BB6B)
voided = 0
for _, _, _, s3, e3 in elements(b, s, e):
    for i4, at, _, s4, e4 in elements(b, s3, e3):
        if i4 != 0xB7: continue
        track = next(int.from_bytes(b[s5:e5], "big") for i5, _, _, s5, e5 in elements(b, s4, e4) if i5 == 0xF7)
        if track in (3, 4, 5, 6):
            b[at] = 0xEC  # a Void element, its size as it was
            b[s4:e4] = bytes(e4 - s4)
            voided += 1
open(f"{out}/subs-uncued.mkv", "wb").write(b)
print(f"subs-uncued.mkv: {voided} subtitle index entries left out")

# subs-reordered.mkv: the regular and forced English tracks' entries swapped, numbers kept, so
# the file's streams are no longer in the order of their track numbers.
b = bytearray(source)
three, four = (x for x in entries(b) if number(b, x) in (3, 4))
b[three[1]:four[4]] = b[four[1]:four[4]] + b[three[1]:three[4]]
open(f"{out}/subs-reordered.mkv", "wb").write(b)
print("subs-reordered.mkv: tracks 4 and 3 in that order")

# subs-zlib.mkv: the forced English track marked as zlib-compressed, which FFmpeg here passes on
# as it is. The Void before the Tracks gives up the room, so nothing after them moves.
b = bytearray(source)
added = bytes.fromhex("6d808a" "624087" "503484" "42548100")
four = next(x for x in entries(b) if number(b, x) == 4)
_, at, header, s, e = four
assert header == 9
entry = b[at:at + 1] + (0x01 << 56 | (e - s + len(added))).to_bytes(8, "big") + b[s:e] + added
_, tat, theader, ts, te = top(b, 0x1654AE6B)
assert theader in (6, 12)
size_length = theader - 4
tracks_size = te - ts + len(added)
tracks = b[tat:tat + 4] + ((1 << (7 * size_length)) | tracks_size).to_bytes(size_length, "big")
tracks += b[ts:at] + entry + b[e:te]
void = top(b, 0xEC)
_, vat, vheader, vs, ve = void
assert vheader == 9 and ve - vs >= len(added)
shrunk = b"\xec" + (0x01 << 56 | (ve - vs - len(added))).to_bytes(8, "big") + bytes(ve - vs - len(added))
assert ve <= tat
b[vat:te] = shrunk + b[ve:tat] + tracks
# The SeekHead's positions of what moved.
_, _, _, ss, se = top(b, 0x114D9B74)
seg = segment(b)[3]
for i, _, _, s2, e2 in elements(b, ss, se):
    if i != 0x4DBB: continue
    fields = {k: (s3, e3) for k, _, _, s3, e3 in elements(b, s2, e2)}
    s3, e3 = fields[0x53AC]
    position = int.from_bytes(b[s3:e3], "big")
    if vat - seg < position < te - seg:
        b[s3:e3] = (position - len(added)).to_bytes(e3 - s3, "big")
open(f"{out}/subs-zlib.mkv", "wb").write(b)
print("subs-zlib.mkv: track 4 marked zlib-compressed")

# subs-badcues.mkv: the index's last field says it is eight bytes long, past the end of the
# Cues, as a damaged file might.
b = bytearray(source)
_, _, _, s, e = top(b, 0x1C53BB6B)
last = None
for _, _, _, s3, e3 in elements(b, s, e):
    for i4, _, _, s4, e4 in elements(b, s3, e3):
        if i4 == 0xB7:
            last = list(elements(b, s4, e4))[-1]
_, at, header, s5, e5 = last
assert header == 2 and b[at + 1] == 0x80 | (e5 - s5)
b[at + 1] = 0x88
open(f"{out}/subs-badcues.mkv", "wb").write(b)
print("subs-badcues.mkv: the index's last field runs past its end")
PY
