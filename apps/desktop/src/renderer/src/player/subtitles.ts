// Shows subtitles on the one video element. Text, whether WebVTT from ffmpeg or decoded here from
// teletext and captions, goes on its subtitle track as cues, which Chromium lays out under the
// picture. Pictures, PGS and DVB, go on a canvas over the picture: cues on a metadata track show
// and hide them, so the element's own clock times them and nothing repaints in between.
//
// The viewer's timing and look live here rather than on the cues, so they hold for whichever track
// shows, after every seek and every new run. Text cues keep the times their file gave them and
// show `delay` seconds later; pictures keep theirs. The look is CSS on the cues (styles.css), and
// a scale when pictures are drawn; how high subtitles sit is CSS for both.
import { createStore, useStore } from "zustand";
import { DEFAULT_SUBTITLE_LOOK, type SubtitleLook } from "@mrstreamer/contracts/preferences";
import {
  isBlank,
  type SubtitleChange,
  type SubtitleScreen,
} from "@mrstreamer/core/subtitles/screen";

/**
 * The end of a cue whose end isn't known yet: later than any title lasts, so the cue stays until
 * the next change ends it, however long that takes. Chromium takes no infinite time.
 */
const NO_END_YET = Number.MAX_VALUE;
/** Cues this far behind the position are let go, pictures with their pixels. */
const KEEP_BEHIND_S = 30;
/** How far G and H move text subtitles, and how far they go at most either way. */
export const TIMING_STEP_S = 0.1;
const TIMING_LIMIT_S = 30;
/** Each size against Chromium's own for text, and the pictures' drawn size. */
const SCALES: Record<SubtitleLook["size"], number> = { small: 0.8, medium: 1, large: 1.3 };

interface SubtitleSettings {
  /** Seconds text subtitles show after the time their file gives; negative shows them earlier. */
  readonly delay: number;
  readonly look: SubtitleLook;
}

const settings = createStore<SubtitleSettings>(() => ({
  delay: 0,
  look: DEFAULT_SUBTITLE_LOOK,
}));

/** Reads the subtitles' timing and look in a component. */
export function useSubtitleSettings<T>(selector: (state: SubtitleSettings) => T): T {
  return useStore(settings, selector);
}

/** The times a text cue's file gave it, which the viewer's timing moves it from. */
const textTimes = new WeakMap<TextTrackCue, { start: number; end: number }>();

/** The canvas pictures are drawn on. Picture.tsx keeps it over the video, wherever that goes. */
export const subtitleCanvas = document.createElement("canvas");
subtitleCanvas.setAttribute("aria-hidden", "true");
subtitleCanvas.dataset["subtitles"] = "";
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
const pictures = new WeakMap<TextTrackCue, SubtitleScreen>();

interface Drawable {
  readonly width: number;
  readonly height: number;
  readonly images: readonly { x: number; y: number; bitmap: ImageBitmap }[];
}

let drawn: Drawable | null = null;
/** Whatever was asked to show last, so a slow bitmap can't replace a newer screen. */
let showing: TextTrackCue | null = null;

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

/** Puts a text cue on `video`'s subtitle track: from `start` to `end` on the file's clock. */
export function addTextCue(
  video: HTMLVideoElement,
  start: number,
  end: number,
  text: string,
): VTTCue {
  const { delay } = settings.getState();
  const cue = new VTTCue(start + delay, end + delay, text);
  textTimes.set(cue, { start, end });
  subtitleTrack(video).addCue(cue);
  return cue;
}

/**
 * Shows text subtitles `delay` seconds after the time their file gives, or before it when
 * negative: those on the track now and every one to come, until a new title or channel. Rounded to
 * tenths, as G and H step.
 */
export function setSubtitleDelay(video: HTMLVideoElement, delay: number): void {
  const rounded = Math.round(Math.min(TIMING_LIMIT_S, Math.max(-TIMING_LIMIT_S, delay)) * 10) / 10;
  settings.setState({ delay: rounded });
  for (const cue of [...(subtitleTrack(video).cues ?? [])]) {
    const times = textTimes.get(cue);
    if (!times) continue;
    cue.startTime = times.start + rounded;
    cue.endTime = times.end + rounded;
  }
}

/** The text subtitles' timing now: seconds after the time their file gives. */
export function subtitleDelay(): number {
  return settings.getState().delay;
}

/** Applies a look to every subtitle, shown now or later; kept until the viewer picks another. */
export function setSubtitleLook(look: SubtitleLook): void {
  settings.setState({ look });
  const root = document.documentElement;
  root.style.setProperty("--subtitle-scale", String(SCALES[look.size]));
  root.dataset["subtitleBackground"] = look.background;
  root.dataset["subtitlePosition"] = look.position;
  repaint();
}

/**
 * Shows decoded subtitles on `video`, whose times are on the element's clock: each change from
 * its time on, until the next one or the time it ends, whichever comes first, and for as long as
 * it takes when neither comes.
 */
export function subtitlePresenter(video: HTMLVideoElement) {
  const text = subtitleTrack(video);
  const timing = pictureTrack(video);
  text.mode = "showing";
  /** The last cue, which the next change ends when that comes before the end it has. */
  let last: VTTCue | null = null;

  /** Draws a picture cue's screen, unless another was asked for before its bitmaps were made. */
  async function draw(cue: TextTrackCue, screen: SubtitleScreen): Promise<void> {
    showing = cue;
    const ready = await drawable(screen);
    if (showing !== cue) {
      for (const image of ready?.images ?? []) image.bitmap.close();
      return;
    }
    release();
    drawn = ready;
    paint(video);
  }

  return {
    /**
     * Draws the picture due at the element's position, without waiting for Chromium to say it is:
     * that comes a moment after the position moves. Resolves once it is on the canvas.
     */
    async drawNow(): Promise<void> {
      const due = [...(timing.cues ?? [])].findLast(
        (cue) => cue.startTime <= video.currentTime && video.currentTime < cue.endTime,
      );
      const screen = due && pictures.get(due);
      if (due && screen) await draw(due, screen);
    },

    show(change: SubtitleChange): void {
      const { at } = change;
      if (last) {
        const times = textTimes.get(last);
        if (times) {
          times.end = Math.min(times.end, Math.max(times.start, at));
          last.endTime = times.end + settings.getState().delay;
        } else {
          last.endTime = Math.min(last.endTime, Math.max(last.startTime, at));
          // A run brings the changes from before its position too. A picture that ends behind
          // the position gets no exit from Chromium, so it goes here.
          if (showing === last && last.endTime <= video.currentTime) {
            showing = null;
            release();
            paint(video);
          }
        }
        last = null;
      }
      // Cues shown long ago go, so a long film or a channel left on all day doesn't keep every one.
      for (const track of [text, timing]) {
        for (const old of [...(track.cues ?? [])]) {
          if (old.endTime < video.currentTime - KEEP_BEHIND_S) track.removeCue(old);
        }
      }
      if (isBlank(change.screen)) return;
      const end = change.until ?? NO_END_YET;
      if (change.screen.kind === "text") {
        last = addTextCue(video, at, end, change.screen.lines.join("\n"));
        return;
      }
      const cue = new VTTCue(at, end, "");
      pictures.set(cue, change.screen);
      cue.onenter = () => {
        // Chromium says so a moment after the cue turns active. By then a cue from before the
        // position may have got its end, behind the position.
        if (cue.endTime <= video.currentTime) return;
        void draw(cue, change.screen);
      };
      cue.onexit = () => {
        if ((timing.activeCues?.length ?? 0) > 0) return;
        if (showing === cue) showing = null;
        release();
        paint(video);
      };
      timing.addCue(cue);
      last = cue;
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
 * the area the picture fills, as broadcasts mean it, whatever its own shape. A size other than
 * medium grows or shrinks them from the middle of the picture's foot, where subtitles sit.
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
  const size = SCALES[settings.getState().look.size];
  const foot = { x: left + area.width / 2, y: top + area.height };
  context.imageSmoothingQuality = "high";
  for (const image of drawn.images) {
    context.drawImage(
      image.bitmap,
      foot.x + (left + image.x * x - foot.x) * size,
      foot.y + (top + image.y * y - foot.y) * size,
      image.bitmap.width * x * size,
      image.bitmap.height * y * size,
    );
  }
}

/** Draws the canvas again for the video it covers, wherever Picture put the two. */
function repaint(): void {
  const video = subtitleCanvas.previousElementSibling;
  if (video instanceof HTMLVideoElement) paint(video);
}

// The canvas follows the element's size; it is drawn again only then and at each change.
new ResizeObserver(repaint).observe(subtitleCanvas);
