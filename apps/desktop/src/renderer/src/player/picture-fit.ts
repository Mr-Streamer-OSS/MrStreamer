import type { PictureRatio, PlaybackAdjustments } from "@mrstreamer/contracts/preferences";

export type PictureAdjustments = Pick<PlaybackAdjustments, "aspect" | "crop" | "zoom">;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Where the whole picture is drawn, in CSS pixels from the area's top left. */
export interface PictureBox extends Size {
  readonly left: number;
  readonly top: number;
}

function ratio(picked: PictureRatio): number {
  const [width, height] = picked.split(":").map(Number);

  return width! / height!;
}

/**
 * Where the whole decoded `frame` goes in `area` under `adjustments`: shown at their aspect, the
 * part a crop keeps fitted inside the area, then zoomed around the centre. What lies outside the
 * area is cut by it. Null while the stream's own shape is wanted and not yet known.
 */
export function pictureBox(
  frame: Size,
  area: Size,
  { aspect, crop, zoom }: PictureAdjustments,
): PictureBox | null {
  const shown =
    aspect === "source"
      ? frame.width && frame.height
        ? frame.width / frame.height
        : 0
      : ratio(aspect);

  if (!shown || !area.width || !area.height) return null;
  const kept = crop === "none" ? shown : ratio(crop);
  const scale = zoom / 100;
  // The kept part fills the area's width or its height, whichever it meets first.
  const keptWidth = (area.width / area.height > kept ? area.height * kept : area.width) * scale;
  const keptHeight = keptWidth / kept;
  // A kept part narrower than the picture cuts its sides; a wider one its top and bottom.
  const width = keptWidth / Math.min(1, kept / shown);
  const height = keptHeight / Math.min(1, shown / kept);

  return { left: (area.width - width) / 2, top: (area.height - height) / 2, width, height };
}
