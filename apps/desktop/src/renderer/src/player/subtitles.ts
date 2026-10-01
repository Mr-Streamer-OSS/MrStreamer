// Shows subtitles on the one video element. Text, whether WebVTT from ffmpeg or decoded here from
// teletext and captions, goes on its subtitle track as cues, which Chromium lays out under the
// picture. Pictures, PGS and DVB, go on a canvas over the picture: cues on a metadata track show
// and hide them, so the element's own clock times them and nothing repaints in between.
import {
  isBlank,
  type SubtitleChange,
  type SubtitleScreen,
} from "@mrstreamer/core/subtitles/screen";

/** How long a cue whose end isn't known yet lasts until the next change closes it. */
const OPEN_END_S = 60 * 60;
/** Picture cues this far behind the position are let go, with their pixels. */
const KEEP_BEHIND_S = 30;

/** The canvas pictures are drawn on. Picture.tsx keeps it over the video, wherever that goes. */
export const subtitleCanvas = document.createElement("canvas");
subtitleCanvas.setAttribute("aria-hidden", "true");
subtitleCanvas.style.cssText =
  "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";

const textTracks = new WeakMap<HTMLVideoElement, TextTrack>();
const pictureTracks = new WeakMap<HTMLVideoElement, TextTrack>();

/** The track text subtitles show on, one per element, reused by every stream. */
export function subtitleTrack(video: HTMLVideoElement): TextTrack {
  let track = textTracks.get(video);
  if (!track) {
    track = video.addTextTrack("subtitles", "Subtitles");
    textTracks.set(video, track);
  }
  return track;
}

/** The hidden track whose cues time the pictures. */
function pictureTrack(video: HTMLVideoElement): TextTrack {
  let track = pictureTracks.get(video);
  if (!track) {
    track = video.addTextTrack("metadata", "Pictures");
    track.mode = "hidden";
    pictureTracks.set(video, track);
    // A new stream can change the picture's shape, and where pictures go on it.
    video.addEventListener("resize", () => paint(video));
  }
  return track;
}

/** The screens picture cues show. Their bitmaps are made when they show and closed after. */
const pictures = new WeakMap<VTTCue, SubtitleScreen>();

interface Drawable {
  readonly width: number;
  readonly height: number;
  readonly images: readonly { x: number; y: number; bitmap: ImageBitmap }[];
}

let drawn: Drawable | null = null;
/** Whatever was asked to show last, so a slow bitmap can't replace a newer screen. */
let showing: VTTCue | null = null;

/** Removes every cue from both tracks and clears the canvas. */
export function clearSubtitles(video: HTMLVideoElement): void {
  for (const track of [subtitleTrack(video), pictureTrack(video)]) {
    for (const cue of [...(track.cues ?? [])]) track.removeCue(cue);
  }
  showing = null;
  release();
  paint(video);
}

/** Lets go of the bitmaps on screen. */
function release(): void {
  for (const image of drawn?.images ?? []) image.bitmap.close();
  drawn = null;
}

/**
 * Shows decoded subtitles on `video`: each change from its time on, until the next one or the
 * time it ends, whichever comes first. `offset` moves times onto the element's clock.
 */
export function subtitlePresenter(video: HTMLVideoElement, offset = 0) {
  const text = subtitleTrack(video);
  const timing = pictureTrack(video);
  text.mode = "showing";
  /** The last cue, open until the next change sets its end. */
  let open: VTTCue | null = null;

  return {
    show(change: SubtitleChange): void {
      const at = change.at - offset;
      if (open) {
        open.endTime = Math.max(open.startTime, at);
        open = null;
      }
      if (isBlank(change.screen)) return;
      const end = change.until === null ? at + OPEN_END_S : change.until - offset;
      if (change.screen.kind === "text") {
        const cue = new VTTCue(at, end, change.screen.lines.join("\n"));
        text.addCue(cue);
        open = change.until === null ? cue : null;
        return;
      }
      const cue = new VTTCue(at, end, "");
      pictures.set(cue, change.screen);
      cue.onenter = () => {
        showing = cue;
        void drawable(change.screen).then((ready) => {
          if (showing !== cue) {
            for (const image of ready?.images ?? []) image.bitmap.close();
            return;
          }
          release();
          drawn = ready;
          paint(video);
        });
      };
      cue.onexit = () => {
        if ((timing.activeCues?.length ?? 0) > 0) return;
        if (showing === cue) showing = null;
        release();
        paint(video);
      };
      timing.addCue(cue);
      open = change.until === null ? cue : null;
      // Pictures shown long ago go, so a long film doesn't keep every one.
      for (const old of [...(timing.cues ?? [])]) {
        if (old !== open && old.endTime < video.currentTime - KEEP_BEHIND_S) timing.removeCue(old);
      }
    },
  };
}

/** A picture screen as bitmaps, made ahead of the time it shows. */
async function drawable(screen: SubtitleScreen): Promise<Drawable | null> {
  if (screen.kind !== "picture") return null;
  const images = await Promise.all(
    screen.pictures.map(async (picture) => ({
      x: picture.x,
      y: picture.y,
      bitmap: await createImageBitmap(
        new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height),
      ),
    })),
  );
  return { width: screen.width, height: screen.height, images };
}

/**
 * Draws the pictures on screen over the video's picture: the subtitles' canvas stretched over
 * the area the picture fills, as broadcasts mean it, whatever its own shape.
 */
function paint(video: HTMLVideoElement): void {
  const canvas = subtitleCanvas;
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * scale);
  const height = Math.round(canvas.clientHeight * scale);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!drawn || !video.videoWidth || !video.videoHeight) return;
  // Where the picture sits in the element, as object-fit places it.
  const fit = getComputedStyle(video).objectFit === "cover" ? Math.max : Math.min;
  const ratio = fit(width / video.videoWidth, height / video.videoHeight);
  const area = {
    width: video.videoWidth * ratio,
    height: video.videoHeight * ratio,
  };
  const left = (width - area.width) / 2;
  const top = (height - area.height) / 2;
  const x = area.width / drawn.width;
  const y = area.height / drawn.height;
  context.imageSmoothingQuality = "high";
  for (const image of drawn.images) {
    context.drawImage(
      image.bitmap,
      left + image.x * x,
      top + image.y * y,
      image.bitmap.width * x,
      image.bitmap.height * y,
    );
  }
}

// The canvas follows the element's size; it is drawn again only then and at each change.
new ResizeObserver(() => {
  const video = subtitleCanvas.previousElementSibling;
  if (video instanceof HTMLVideoElement) paint(video);
}).observe(subtitleCanvas);
