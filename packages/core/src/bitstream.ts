// Reading H.264 and HEVC headers, which pack numbers bit by bit, most significant bit first.

/** Removes the emulation prevention bytes: 00 00 03 becomes 00 00. */
export function unescape(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let length = 0;

  for (let index = 0; index < data.length; index++) {
    if (index >= 2 && data[index] === 3 && data[index - 1] === 0 && data[index - 2] === 0) continue;
    out[length++] = data[index]!;
  }

  return out.subarray(0, length);
}

/**
 * Reads `bytes` from their first bit. A read past the end, or an Exp-Golomb code too long to be
 * real, gives 0 and sets `overrun`, so a parser checks once after its last read.
 */
export function bitReader(bytes: Uint8Array) {
  let position = 0;
  let overrun = false;

  const bit = (): number => {
    if (position >= bytes.length * 8) {
      overrun = true;

      return 0;
    }

    const value = (bytes[position >> 3]! >> (7 - (position & 7))) & 1;
    position++;

    return value;
  };

  /** An unsigned number of `count` bits, up to 31. */
  const bits = (count: number): number => {
    let value = 0;

    for (let n = 0; n < count; n++) value = value * 2 + bit();

    return value;
  };

  /** ue(v): an unsigned Exp-Golomb number. */
  const ue = (): number => {
    let zeros = 0;

    while (bit() === 0) {
      if (overrun || ++zeros > 31) {
        overrun = true;

        return 0;
      }
    }

    return 2 ** zeros - 1 + bits(zeros);
  };

  /** se(v): a signed Exp-Golomb number. */
  const se = (): number => {
    const code = ue();

    return code % 2 === 1 ? (code + 1) / 2 : -code / 2;
  };

  return {
    bits,
    ue,
    se,
    get overrun() {
      return overrun;
    },
  };
}
