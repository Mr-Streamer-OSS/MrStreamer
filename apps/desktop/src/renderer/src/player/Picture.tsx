// Where the picture shows. Single/title views share a video; a pane supplies its own. Each renders a
// <Picture>, and the active one holds the element. Moving it uses moveBefore,
// which keeps a playing element playing, so changing views never interrupts the stream.
import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
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

/**
 * A place for the picture. While `active`, the video fills this element, scaled to `fit`. Only one
 * Picture per video should be active at a time; the one activated last holds that element.
 */
export function Picture({
  active,
  fit,
  video: suppliedVideo,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  active: boolean;
  fit: "contain" | "cover";
  video?: HTMLVideoElement;
}) {
  const selectedVideo = usePlayerVideo();
  const video = suppliedVideo ?? selectedVideo;
  const box = useRef<HTMLDivElement>(null);
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

  return <div ref={box} {...props} />;
}
