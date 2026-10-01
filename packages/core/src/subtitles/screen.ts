// What subtitles put on screen, whatever carried them: lines of text, or pictures placed on a
// canvas the size the subtitles were made for. Decoders turn a stream's packets into changes of
// this screen; the player shows each change from its time on.

/** What subtitles show: lines of text, or pictures. Nothing to show is an empty screen. */
export type SubtitleScreen =
  | { readonly kind: "text"; readonly lines: readonly string[] }
  | {
      readonly kind: "picture";
      /** The canvas the pictures are placed on, scaled to the video as a whole. */
      readonly width: number;
      readonly height: number;
      readonly pictures: readonly SubtitlePicture[];
    };

/** One picture, as RGBA pixels, at its place on the canvas. */
export interface SubtitlePicture {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

/** The screen from `at` seconds on, until `until` when the subtitles say when it ends. */
export interface SubtitleChange {
  readonly at: number;
  readonly until: number | null;
  readonly screen: SubtitleScreen;
}

/** Whether a screen shows nothing. */
export function isBlank(screen: SubtitleScreen): boolean {
  return screen.kind === "text" ? screen.lines.length === 0 : screen.pictures.length === 0;
}
