#!/usr/bin/env bash
# Makes the synthetic Matroska files the subtitle checks read, into a folder, with ffmpeg's own
# test sources and subtitles written here; nothing comes from a broadcast or a provider:
#   modules/title-formats/reference/subtitle-fixtures.sh <out-folder>
#
# - subs.mkv: a minute of H.264 (a keyframe every 2 s) with AAC, and text subtitles whose lines
#   outlast several segments: English SubRip with a 35-second line, lines over it, tags and a "<"
#   that opens none, forced English SubRip, French ASS with italics, overrides, a drawing in a
#   line and lines that are only drawings, and German WebVTT, copied as written. Each line is stored
#   where its time falls, and the index lists every subtitle line with its length.
# - subs-uncued.mkv: the same file with every subtitle line left out of its index, each entry
#   overwritten by a Void element of its size, so nothing else moves.
# - subs-reordered.mkv: the same with the regular and forced English tracks' entries in the other
#   order, so streams aren't in the order of their track numbers.
# - subs-zlib.mkv: the same with the forced English track marked as zlib-compressed, its lines
#   left as they are. An ffmpeg with zlib can't read them, so verify.py doesn't check this one;
#   its picture and sound are those of subs.mkv.
# - subs-far.mkv: the same mark, in a copy whose 300 KB ASS header puts its Tracks past the first
#   256 KB.
# - subs-badcues.mkv: the same with the index's last field running past the end of the index.
# - subs-drawing.mkv: its picture and sound with French ASS holding a 111 KB drawing between two
#   lines, which must still show.
# - subs-longline.mkv: its picture and sound with French SubRip holding a 70 KB line, too large
#   to keep, between two lines.
# - subs-hidden.mkv: subs-far.mkv with no SeekHead entry for its Tracks.
# - subs-bzip2, -encrypted, -stripped, -private and -twice.mkv: track 4 encoded otherwise.
# - subs-many.mkv: over 4 MB of French SubRip lines in the first segment; subs-huge.mkv: one in a
#   packet over 1 MB.
# - subs-dvb.mkv: English SubRip and Dutch DVB subtitles.
# - subs-crowded.mkv: its picture and sound with the Dutch DVB track 20 times over, past the 16
#   unshown tracks the core names.
# Needs an ffmpeg with libx264 and its AAC encoder on PATH, as Ubuntu's and Homebrew's builds have.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
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

5
00:00:55,000 --> 00:00:57,000
I <3 you > them
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
Dialogue: 0,0:00:44.00,0:00:46.00,Default,,0,0,0,,{\p1}m 0 0 l 20 0 20 20{\p0}
Dialogue: 0,0:00:52.00,0:00:54.00,Default,,0,0,0,,{\p1}m 0 0 l 20 0 20 20{\p0}
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
  -c:a aac -b:a 96k -c:s copy -max_interleave_delta 0 \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=eng -metadata:s:s:2 language=fra \
  -metadata:s:s:3 language=ger -disposition:s:0 0 -disposition:s:1 forced \
  -disposition:s:2 0 -disposition:s:3 0 -fflags +bitexact "$out/subs.mkv"

# A 111 KB ASS drawing between two lines, which shows nothing and so is kept as nothing, and a
# 70 KB SubRip line, too large to keep, each in a copy of its own.
python3 -I - "$work" <<'PY'
import sys
work = sys.argv[1]
ass = open(f"{work}/french.ass").read().split("[Events]")[0]
drawing = "{\\p1}m 0 0 " + "l 1 1 " * 18500 + "{\\p0}"
open(f"{work}/drawing.ass", "w").write(ass + "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Avant\n"
    f"Dialogue: 0,0:00:21.00,0:00:23.00,Default,,0,0,0,,{drawing}\n"
    "Dialogue: 0,0:00:25.00,0:00:27.00,Default,,0,0,0,,Après\n")
open(f"{work}/long.srt", "w").write("1\n00:00:05,000 --> 00:00:07,000\nBefore\n\n"
    "2\n00:00:21,000 --> 00:00:23,000\n" + "x" * 70000 + "\n\n"
    "3\n00:00:25,000 --> 00:00:27,000\nAfter\n")
PY
# Over 4 MB of lines, all within the first segment, and a line of a packet over 1 MB.
python3 -I - "$work" <<'PY'
import sys
work = sys.argv[1]
line = "Une ligne parmi beaucoup, assez longue pour peser cent octets avec son numero "
open(f"{work}/many.srt", "w").write("".join(
    f"{i + 1}\n00:00:01,{i % 1000:03d} --> 00:00:03,000\n{line}{i:07d}\n\n" for i in range(52000)))
open(f"{work}/huge.srt", "w").write("1\n00:00:21,000 --> 00:00:23,000\n" + "y" * 1_100_000 + "\n")
PY
ffmpeg -v error -y -i "$out/subs.mkv" -i "$work/many.srt" -map 0:0 -map 0:1 -map 1 -c copy \
  -metadata:s:s:0 language=fra -fflags +bitexact "$out/subs-many.mkv"
ffmpeg -v error -y -i "$out/subs.mkv" -i "$work/huge.srt" -map 0:0 -map 0:1 -map 1 -c copy \
  -metadata:s:s:0 language=fra -fflags +bitexact "$out/subs-huge.mkv"
# DVB subtitles from the desktop's channel clip; Matroska carries them, not teletext.
ffmpeg -v error -y -i "$out/subs.mkv" -i "$here/../../../../desktop/test/fixtures/h264-subtitles.mpegts" \
  -map 0:0 -map 0:1 -map 0:2 -map 1:3 -c copy -fflags +bitexact "$out/subs-dvb.mkv"
crowded=()
for _ in $(seq 20); do crowded+=(-map 1:3); done
ffmpeg -v error -y -i "$out/subs.mkv" -i "$here/../../../../desktop/test/fixtures/h264-subtitles.mpegts" \
  -map 0:0 -map 0:1 "${crowded[@]}" -c copy -fflags +bitexact "$out/subs-crowded.mkv"

for kind in drawing:ass longline:srt; do
  name=${kind%:*} codec=${kind#*:}
  input=$work/drawing.ass
  [[ $name == longline ]] && input=$work/long.srt
  ffmpeg -v error -y -i "$out/subs.mkv" -i "$input" -map 0:0 -map 0:1 -map 1 -c copy -c:s "$codec" \
    -metadata:s:s:0 language=fra -fflags +bitexact "$out/subs-$name.mkv"
done

# The same with an ASS header of 300 KB of comments, for subs-far.mkv.
{
  sed -n '1,/^PlayResY/p' "$work/french.ass"
  for i in $(seq 1 6000); do echo "; padding line $i of a long ASS header, as some typesetting has"; done
  sed -n '/^PlayResY/,$p' "$work/french.ass" | tail -n +2
} >"$work/french-long.ass"
ffmpeg -v error -y -i "$out/subs.mkv" -i "$work/french-long.ass" -map 0:0 -map 0:1 -map 0:2 \
  -map 0:3 -map 1 -map 0:5 -c copy -c:s:2 ass -metadata:s:s:2 language=fra -fflags +bitexact \
  "$out/far.mkv"

# The subtitle tracks are the file's third to sixth.
python3 -I - "$out" <<'PY'
import os, sys
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

# ContentEncodings for track 4: the ContentEncoding elements given, in hex.
def encodings(*each):
    inner = b"".join(bytes([0x62, 0x40, 0x80 | len(bytes.fromhex(e))]) + bytes.fromhex(e) for e in each)
    return bytes([0x6D, 0x80, 0x80 | len(inner)]) + inner

ZLIB = "503484" "42548100"  # ContentCompression, ContentCompAlgo 0

def zlib(b, added=encodings(ZLIB)):
    """The forced English track, track 4, given `added` ContentEncodings, zlib's by default, its
    lines as they are. The Void before the Tracks gives up the room, so nothing after them
    moves."""
    four = next(x for x in entries(b) if number(b, x) == 4)
    _, at, header, s, e = four
    assert header == 9
    entry = b[at:at + 1] + (0x01 << 56 | (e - s + len(added))).to_bytes(8, "big") + b[s:e] + added
    _, tat, theader, ts, te = top(b, 0x1654AE6B)
    size_length = theader - 4
    tracks = b[tat:tat + 4] + ((1 << (7 * size_length)) | (te - ts + len(added))).to_bytes(size_length, "big")
    tracks += b[ts:at] + entry + b[e:te]
    _, vat, vheader, vs, ve = top(b, 0xEC)
    assert vheader == 9 and ve - vs >= len(added) and ve <= tat
    shrunk = b"\xec" + (0x01 << 56 | (ve - vs - len(added))).to_bytes(8, "big") + bytes(ve - vs - len(added))
    b[vat:te] = shrunk + b[ve:tat] + tracks
    # The SeekHead's positions of what moved.
    _, _, _, ss, se = top(b, 0x114D9B74)
    seg = segment(b)[3]
    for i, _, _, s2, e2 in elements(b, ss, se):
        if i != 0x4DBB: continue
        s3, e3 = {k: (x, y) for k, _, _, x, y in elements(b, s2, e2)}[0x53AC]
        position = int.from_bytes(b[s3:e3], "big")
        if vat - seg < position < te - seg:
            b[s3:e3] = (position - len(added)).to_bytes(e3 - s3, "big")
    return b

# subs-zlib.mkv: the forced English track marked as zlib-compressed, which FFmpeg here passes on
# as it is.
open(f"{out}/subs-zlib.mkv", "wb").write(zlib(bytearray(source)))
print("subs-zlib.mkv: track 4 marked zlib-compressed")

# subs-far.mkv: the same mark in a file whose ASS header makes its Tracks larger than the start
# the core keeps, so the core reads them from where the SeekHead says.
far = zlib(bytearray(open(f"{out}/far.mkv", "rb").read()))
open(f"{out}/subs-far.mkv", "wb").write(far)
os.remove(f"{out}/far.mkv")
print("subs-far.mkv: track 4 marked zlib-compressed, its Tracks past the first 256 KB")

# subs-hidden.mkv: subs-far.mkv without its SeekHead's entry for the Tracks, so the core can't
# read them and knows no text track's encoding.
_, _, _, ss, se = top(far, 0x114D9B74)
for i, at, header, s2, e2 in elements(far, ss, se):
    if i == 0x4DBB and any(k == 0x53AB and far[x:y] == bytes.fromhex("1654ae6b") for k, _, _, x, y in elements(far, s2, e2)):
        # A Void element of the same length: its one-byte ID, then a one-byte size.
        assert header == 3 and e2 - at - 2 < 0x7F
        far[at:e2] = bytes([0xEC, 0x80 | (e2 - at - 2)]) + bytes(e2 - at - 2)
open(f"{out}/subs-hidden.mkv", "wb").write(far)
print("subs-hidden.mkv: no SeekHead entry for its Tracks")

# Other encodings of track 4: bzip2 and encryption, which can't be read here; header stripping
# and zlib for the codec's private data only, which can; and two encodings, of which FFmpeg
# reads none.
for name, added in [
    ("bzip2", encodings("503484" "42548101")),
    ("encrypted", encodings("503381" "01" "503580")),
    ("stripped", encodings("503484" "42548103")),
    ("private", encodings("503281" "02" + ZLIB)),
    ("twice", encodings("503484" "42548103", "503484" "42548103")),
]:
    open(f"{out}/subs-{name}.mkv", "wb").write(zlib(bytearray(source), added))
    print(f"subs-{name}.mkv: track 4 encoded")

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
