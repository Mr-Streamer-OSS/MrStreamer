// Subtitle cues from a WebVTT stream as it arrives: ffmpeg writes them as the title plays, a
// little ahead of the picture, so they are read piece by piece rather than as a whole file.

export interface Cue {
  /** Seconds on the file's clock. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Reads WebVTT text in pieces. `push` returns the cues completed by that piece; a cue ends at the
 * blank line after it, so the last one comes with `end`.
 */
export function webvttReader() {
  let pending = "";
  const read = (block: string): Cue | null => {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) return null;
    const [from = "", to = ""] = lines[timing]?.split("-->") ?? [];
    const start = seconds(from);
    const end = seconds(to.trim().split(/\s+/)[0] ?? "");
    const text = lines
      .slice(timing + 1)
      .join("\n")
      .trim();
    return start === null || end === null || !text ? null : { start, end, text };
  };
  return {
    push(text: string): Cue[] {
      pending += text.replace(/\r\n?/g, "\n");
      const blocks = pending.split(/\n\n+/);
      pending = blocks.pop() ?? "";
      return blocks.flatMap((block) => read(block) ?? []);
    },
    end(): Cue[] {
      const last = read(pending);
      pending = "";
      return last ? [last] : [];
    },
  };
}

/** "01:02:03.500" or "02:03.500" in seconds. */
function seconds(text: string): number | null {
  const parts = text.trim().split(":").map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
