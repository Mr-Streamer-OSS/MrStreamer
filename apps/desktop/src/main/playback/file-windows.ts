// Parts of a movie's file kept in memory while a subtitle track's past is read from it: the
// file's descriptions, and the stretches stepped through for the track's packets. Each is one
// answer of the provider's. The ones used longest ago go first. They are of one file, and go
// with it (see ../services/playback.ts).

export type FileWindows = ReturnType<typeof fileWindows>;

/** Keeps at most `limit` bytes. */
export function fileWindows(limit: number) {
  /** By where each starts; the one used last is last. */
  const windows = new Map<number, Buffer>();
  let bytes = 0;
  let most = 0;

  return {
    /** `length` bytes from `start`, fewer at the end of a window that reaches the file's end; null when not kept whole. */
    read(start: number, length: number, size: number | null): Buffer | null {
      for (const [at, data] of windows) {
        const end = at + data.length;
        if (at > start || end <= start) continue;
        if (start + length > end && end !== size) continue;
        windows.delete(at);
        windows.set(at, data);
        return data.subarray(start - at, start - at + length);
      }
      return null;
    },

    keep(start: number, data: Buffer): void {
      if (data.length === 0 || data.length > limit) return;
      bytes += data.length - (windows.get(start)?.length ?? 0);
      windows.delete(start);
      windows.set(start, data);
      for (const [at, oldest] of windows) {
        if (bytes <= limit) break;
        windows.delete(at);
        bytes -= oldest.length;
      }
      most = Math.max(most, bytes);
    },

    /** The most bytes kept at once so far. */
    get most(): number {
      return most;
    },
  };
}
