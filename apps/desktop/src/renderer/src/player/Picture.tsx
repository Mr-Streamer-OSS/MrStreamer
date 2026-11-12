// Where the picture shows. Single/title views share a video; a pane supplies its own. Each renders a
// <Picture>, and the active one holds the element. Moving it uses moveBefore,
// which keeps a playing element playing, so changing views never interrupts the stream.
//
// An `adjusted` Picture, where the viewer watches, shows the picture at the viewer's aspect, crop
// and zoom (see adjustments.ts); previews and panes show it as the stream does.
import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { isAdjusted } from "@mrstreamer/contracts/preferences";
import { usePlaybackAdjustments } from "./adjustments.ts";
import { pictureBox, type PictureAdjustments } from "./picture-fit.ts";
import { usePlayerVideo } from "./player.ts";
import { subtitleLayerFor } from "./subtitles.ts";

/** Holds the element while no Picture is active, so it never leaves the document. */
let parking: HTMLDivElement | null = null;

function parkingSpot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.setAttribute("aria-hidden", "true");
    parking.style.cssText =
      "position:fixed;left:-2px;top:-2px;width:1px;height:1px;overflow:hidden;pointer-events:none";
    document.body.append(parking);
  }

  return parking;
}

/** Moves `node` to the end of `parent`, keeping its state when both are in the document. */
function move(parent: Element, node: Element): void {
  if (parent.isConnected && node.isConnected) {
    try {
      parent.moveBefore(node, null);

      return;
    } catch {
      // Falls back to a plain move below.
    }
  }

  parent.append(node);
}

/** The styles an adjusted picture sets on the video, cleared when it leaves. */
const PLACED = ["position", "left", "top", "width", "height", "max-width", "max-height"] as const;

/**
 * Draws `video` in `container` at `adjustments`, again whenever either changes size. Returns the
 * function that puts it back at `fit`.
 */
function place(
  video: HTMLVideoElement,
  container: HTMLElement,
  adjustments: PictureAdjustments,
  fit: "contain" | "cover",
): () => void {
  const layout = () => {
    const box = pictureBox(
      { width: video.videoWidth, height: video.videoHeight },
      { width: container.clientWidth, height: container.clientHeight },
      adjustments,
    );

    if (!box) {
      for (const property of PLACED) video.style.removeProperty(property);
      video.style.objectFit = fit;

      return;
    }

    Object.assign(video.style, {
      position: "absolute",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      maxWidth: "none",
      maxHeight: "none",
      objectFit: "fill",
    });
  };

  layout();
  const resized = new ResizeObserver(layout);
  resized.observe(container);
  // A stream's picture size is known once its first frame is, and can change mid-stream.
  video.addEventListener("resize", layout);

  return () => {
    resized.disconnect();
    video.removeEventListener("resize", layout);

    for (const property of PLACED) video.style.removeProperty(property);
    video.style.objectFit = fit;
  };
}

/**
 * A place for the picture. While `active`, the video fills this element, scaled to `fit`, or with
 * `adjusted` as the viewer's picture adjustments say. Only one Picture per video should be active
 * at a time; the one activated last holds that element.
 */
export function Picture({
  active,
  adjusted = false,
  fit,
  video: suppliedVideo,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  active: boolean;
  adjusted?: boolean;
  fit: "contain" | "cover";
  video?: HTMLVideoElement;
}) {
  const selectedVideo = usePlayerVideo();
  const video = suppliedVideo ?? selectedVideo;
  const box = useRef<HTMLDivElement>(null);
  const aspect = usePlaybackAdjustments((state) => state.adjustments.aspect);
  const crop = usePlaybackAdjustments((state) => state.adjustments.crop);
  const zoom = usePlaybackAdjustments((state) => state.adjustments.zoom);
  const placed = adjusted && isAdjusted({ aspect, crop, zoom });
  useLayoutEffect(() => {
    const container = box.current;

    if (!active || !container) return;
    video.style.objectFit = fit;
    move(container, video);
    const subtitleLayer = subtitleLayerFor(video);
    // Subtitles stay over the picture.
    move(container, subtitleLayer);

    // Runs before React removes this element, so the video leaves while still in the document.
    return () => {
      if (video.parentElement !== container) return;
      move(parkingSpot(), video);
      move(parkingSpot(), subtitleLayer);
    };
  }, [active, fit, video]);
  useLayoutEffect(() => {
    const container = box.current;

    if (!active || !placed || !container) return;

    return place(video, container, { aspect, crop, zoom }, fit);
  }, [active, placed, fit, video, aspect, crop, zoom]);

  // A zoomed or cropped picture is cut by this element.
  return <div ref={box} style={placed ? { ...style, overflow: "hidden" } : style} {...props} />;
}
