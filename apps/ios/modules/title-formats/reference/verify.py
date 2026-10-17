# Checks a reference run's renditions against the source with system ffprobe and ffmpeg:
# every packet's payload equals the source track's, in order, with its time within half a frame
# of the source's time from the first cut; the picture's times are exact; each rendition decodes.
# An AAC-LC rendition may add one frame of silence wherever the track has none; it must run
# without gaps from its first frame to within one frame past the picture's end, and decode to
# zero over each added frame after the first in a row.
#   python3 -I verify.py <source.mkv> <out-folder>
import glob, json, os, re, subprocess, sys

source, folder = sys.argv[1], sys.argv[2]

def packets(path, stream):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", str(stream), "-show_entries",
        "packet=pts_time,data_hash", "-show_data_hash", "MD5", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    return [(float(p["pts_time"]), p["data_hash"]) for p in json.loads(out)["packets"]]

def presented(init, segments, timed=False):
    """Presentation times read from the MP4 boxes themselves: tfdt, then each sample's duration
    (trun, else tfhd's default) and composition offset, over the timescale in mdhd. With `timed`,
    each sample's decode time and duration instead, in the timescale, and the timescale."""
    import struct
    def boxes(b, o, e):
        while o + 8 <= e:
            size, kind = struct.unpack(">I4s", b[o:o+8]); h = 8
            if size == 1: size = struct.unpack(">Q", b[o+8:o+16])[0]; h = 16
            yield kind.decode(), o + h, o + size
            o += size
    data = open(init, "rb").read(); i = data.find(b"mdhd"); v = data[i + 4]
    scale = struct.unpack(">I", data[i + (24 if v else 16):i + (28 if v else 20)])[0]
    times = []
    for name in segments:
        b = open(name, "rb").read()
        for kind, s, e in boxes(b, 0, len(b)):
            if kind != "moof": continue
            for k2, s2, e2 in boxes(b, s, e):
                if k2 != "traf": continue
                default = None
                for k3, s3, e3 in boxes(b, s2, e2):
                    if k3 == "tfhd":
                        fl = int.from_bytes(b[s3+1:s3+4], "big"); p = s3 + 8
                        if fl & 1: p += 8
                        if fl & 2: p += 4
                        if fl & 8: default = struct.unpack(">I", b[p:p+4])[0]
                    if k3 == "tfdt":
                        dt = struct.unpack(">Q" if b[s3] else ">I", b[s3+4:s3+(12 if b[s3] else 8)])[0]
                    if k3 == "trun":
                        ver = b[s3]; fl = int.from_bytes(b[s3+1:s3+4], "big"); n = struct.unpack(">I", b[s3+4:s3+8])[0]; p = s3 + 8
                        if fl & 1: p += 4
                        if fl & 4: p += 4
                        for _ in range(n):
                            d = default; c = 0
                            if fl & 0x100: d = struct.unpack(">I", b[p:p+4])[0]; p += 4
                            if fl & 0x200: p += 4
                            if fl & 0x400: p += 4
                            if fl & 0x800: c = struct.unpack(">i" if ver else ">I", b[p:p+4])[0]; p += 4
                            times.append((dt, d) if timed else (dt + c) / scale); dt += d
    return (times, scale) if timed else times

def joined(rendition):
    names = sorted(glob.glob(f"{folder}/{rendition}*.m4s"), key=lambda n: int(re.findall(r"(\d+)\.m4s$", n)[0]))
    path = f"{folder}/{rendition}-all.mp4"
    with open(path, "wb") as out:
        out.write(open(f"{folder}/{rendition}.mp4", "rb").read())
        for name in names: out.write(open(name, "rb").read())
    return path

streams = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=index,codec_type,codec_name,profile,sample_rate",
    "-of", "json", source], capture_output=True, text=True, check=True).stdout)["streams"]
master = open(f"{folder}/main.m3u8").read()
audio = [s for s in streams if s["codec_type"] == "audio" and s["codec_name"] in ("aac", "ac3", "eac3", "mp3")]
video = next(s for s in streams if s["codec_type"] == "video")
origin = min(t for t, _ in packets(source, video["index"]))  # the first keyframe: title time 0
ok = True
picture_end = None
for rendition, track in [("v", video)] + [(f"a{i}", s) for i, s in enumerate(audio)]:
    if f'URI="{rendition}.m3u8"' not in master and rendition != "v": continue
    path = joined(rendition)
    mine = packets(path, 0)
    theirs = [(t - origin, h) for t, h in packets(source, track["index"])]
    filled = ""
    if rendition != "v":
        # Frames the source doesn't have are silence: one payload, on the grid, nothing missing.
        ours = {h for _, h in theirs}
        silent = {h for _, h in mine if h not in ours}
        names = sorted(glob.glob(f"{folder}/{rendition}-*.m4s"), key=lambda n: int(re.findall(r"(\d+)\.m4s$", n)[0]))
        timed, rate = presented(f"{folder}/{rendition}.mp4", names, timed=True)
        timed = [(t, d, h) for (t, d), (_, h) in zip(timed, mine)]
        runs = all(a[0] + a[1] == b[0] for a, b in zip(timed, timed[1:]))
        end = (timed[-1][0] + timed[-1][1]) / rate
        if len(silent) == 1:
            pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-"], capture_output=True).stdout
            first = timed[0][0]
            loud = sum(1 for a, b in zip(timed, timed[1:]) if a[2] in silent and b[2] in silent
                       and any(pcm[2 * (b[0] - first):2 * (b[0] - first + b[1])]))
            whole = track["codec_name"] == "aac" and track.get("profile") == "LC"
            good_fill = whole and runs and picture_end <= end <= picture_end + timed[-1][1] / rate and not loud
            filled = (f", {sum(1 for p in mine if p[1] in silent)} silent frames, "
                      f"{'continuous' if runs else 'GAPS'} to {end:.3f} s, {loud} silent frames not silent")
            mine = [p for p in mine if p[1] not in silent]
            ok &= good_fill
        elif track["codec_name"] == "aac" and track.get("profile") == "LC" and not runs:
            filled = ", GAPS in AAC"
            ok = False
    # The source's packets from where the rendition's first one is.
    start = next(i for i, (_, h) in enumerate(theirs) if h == mine[0][1])
    theirs = theirs[start:start + len(mine)]
    same = [a[1] == b[1] for a, b in zip(mine, theirs)]
    frame = {"aac": 1024, "ac3": 1536, "eac3": 1536, "mp3": 1152}.get(track["codec_name"], 0)
    limit = frame / int(track.get("sample_rate", 1)) / 2 + 0.0011 if frame else 0.0005
    if rendition == "v":
        names = sorted(glob.glob(f"{folder}/v*.m4s"), key=lambda n: int(re.findall(r"(\d+)\.m4s$", n)[0]))
        shown = presented(f"{folder}/v.mp4", names)
        timed, scale = presented(f"{folder}/v.mp4", names, timed=True)
        picture_end = (timed[-1][0] + timed[-1][1]) / scale
        drift = max(abs(a - b) for a, b in zip(shown, [t for t, _ in theirs]))
    else:
        drift = max(abs(a[0] - b[0]) for a, b in zip(mine, theirs))
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"], capture_output=True, text=True).stderr.strip()
    good = all(same) and len(mine) == len(theirs) and drift <= limit and not decoded
    ok &= good
    print(f"{rendition} {track['codec_name']}: {len(mine)} packets, payloads {'equal' if all(same) else 'DIFFER'}, "
          f"from source packet {start}, largest time difference {drift*1000:.2f} ms (limit {limit*1000:.2f}), "
          f"decode {'clean' if not decoded else 'ERRORS ' + decoded[:200]}{filled} -> {'ok' if good else 'FAIL'}")
sys.exit(0 if ok else 1)
