"""Mutate only synthetic FLAC fixtures; rebuild Matroska sizes and index offsets on growth."""
from pathlib import Path
import sys

out = Path(sys.argv[1])
base = (out / 'stereo16.mkv').read_bytes()


def vint(b, at, mask=True):
    n = 1
    while not b[at] & (0x80 >> (n - 1)):
        n += 1
    value = int.from_bytes(b[at:at+n], 'big')
    return (value & ((1 << (7*n))-1) if mask else value), n


def elements(b, start, end):
    while start < end:
        kind, k = vint(b, start, False)
        size, n = vint(b, start+k)
        yield kind, start, k, n, start+k+n, start+k+n+size
        start += k+n+size


def flac_frames(b):
    """Each FLAC frame's position and length among the SimpleBlocks of Matroska file b."""
    segment = next(e for e in elements(b, 0, len(b)) if e[0] == 0x18538067)
    result = []
    for kind, at, k, n, s, e in elements(b, segment[4], segment[5]):
        if kind != 0x1F43B675:
            continue
        for kind2, at2, k2, n2, s2, e2 in elements(b, s, e):
            if kind2 == 0xA3:
                p = s2 + vint(b, s2)[1] + 3
                if b[p:p+2] == b'\xff\xf8':
                    result.append((p, e2-p))
    return result


segment = next(e for e in elements(base, 0, len(base)) if e[0] == 0x18538067)
seg = segment[4]
top = list(elements(base, seg, segment[5]))
frames = flac_frames(base)
assert len(frames) > 150
info = base.index(b'fLaC') + 8
assert int.from_bytes(base[info:info+2], 'big') == 4608


def crc(data, bits, poly):
    value = 0
    for byte in data:
        value ^= byte << (bits - 8)
        for _ in range(8):
            value = ((value << 1) ^ (poly if value & (1 << (bits - 1)) else 0)) & ((1 << bits) - 1)
    return value


def header_end(f):
    # FLAC's coded number uses UTF-8 rather than EBML's vint.
    lead = f[4]
    width = 1 if lead < 128 else 2 if lead < 224 else 3
    return 4 + width + {6: 1, 7: 2}.get(f[2] >> 4, 0) + {12: 1, 13: 2, 14: 2}.get(f[2] & 15, 0)


block4096 = (out / 'block4096.mkv').read_bytes()
alternate = [block4096[p:p+n] for p, n in flac_frames(block4096)]


def changed_frame(f, mode):
    end = header_end(f)
    if mode == 'variable-strategy':
        f[1] |= 1
    elif mode == 'zero-rate':
        assert f[2] & 15 < 12
        f[2] = (f[2] & 0xF0) | 12
        f[end:end] = b'\0'
        end += 1
    elif mode == 'overlong-number':
        assert f[4] < 128
        f[4:5] = bytes([0xC0 | (f[4] >> 6), 0x80 | (f[4] & 63)])
        end += 1
    f[end] = crc(f[:end], 8, 7)
    f[-2:] = crc(f[:-2], 16, 0x8005).to_bytes(2, 'big')
    assert crc(f[:end+1], 8, 7) == crc(f, 16, 0x8005) == 0
    return f


# Containers that need traversal to resize blocks and update SeekPosition/CueClusterPosition.
containers = {0x18538067, 0x1F43B675, 0x114D9B74, 0x4DBB, 0x1C53BB6B, 0xBB, 0xB7}


def rebuild(b, start, end, replacements, positions):
    result = bytearray()
    for kind, at, k, n, s, e in elements(b, start, end):
        payload = b[s:e]
        if kind in containers:
            payload = rebuild(b, s, e, replacements, positions)
        elif kind == 0xA3:
            _, width = vint(b, s)
            p = s + width + 3
            if p in replacements:
                payload = b[s:p] + replacements[p]
        elif kind in (0x53AC, 0xF1):
            old = int.from_bytes(payload, 'big')
            payload = positions.get(old, old).to_bytes(e-s, 'big')
        result += b[at:at+k] + ((1 << (7*n)) | len(payload)).to_bytes(n, 'big') + payload
    return result


def save(mode):
    b = bytearray(base)
    replacements = {}
    if mode == 'variable-info':
        b[info:info+2] = (4096).to_bytes(2, 'big')
    else:
        selected = {'corrupt-middle': [len(frames)//2], 'corrupt-first': [0],
                    'corrupt-last': [len(frames)-1],
                    'zero-rate': [60], 'overlong-number': [60],
                    'variable-strategy': range(len(frames)),
                    'length-change': range(len(frames)//2, len(frames))}[mode]
        for i in selected:
            p, n = frames[i]
            f = bytearray(b[p:p+n])
            if mode.startswith('corrupt'):
                f[n//2] ^= 1
            elif mode == 'length-change':
                # Actual valid 4096-sample frames replacing the second half of a 4608 grid.
                f = alternate[i]
            else:
                f = changed_frame(f, mode)
            replacements[p] = f
    positions, shift = {}, 0
    for kind, at, k, n, s, e in top:
        positions[at-seg] = at-seg+shift
        shift += sum(len(f)-dict(frames)[p] for p, f in replacements.items() if s <= p < e)
    result = rebuild(b, 0, len(b), replacements, positions)
    (out / (mode + '.mkv')).write_bytes(result)


for mode in ('corrupt-middle', 'corrupt-first', 'corrupt-last', 'variable-info',
             'variable-strategy', 'length-change', 'zero-rate', 'overlong-number'):
    save(mode)
    print(mode + '.mkv')
