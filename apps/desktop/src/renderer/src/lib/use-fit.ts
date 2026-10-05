import { useCallback, useState, type RefCallback } from "react";
import { useRem } from "./use-rem.ts";

/** The gap between the tiles of a row. */
const GAP_REM = 1;

/**
 * How many tiles fit across the rows of Home, Movies and Series, which each show one line. The
 * returned ref goes on the element that holds the rows inside 2.5rem of padding on each side;
 * `fit(tileRem)` is how many tiles at least that wide fit across, never fewer than one.
 */
export function useFit(): [ref: RefCallback<HTMLDivElement>, fit: (tileRem: number) => number] {
  const rem = useRem();
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLDivElement) => {
    const measure = () => setWidth(element.clientWidth);
    // Measured as it mounts too, so the first frame already shows what fits.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gap = GAP_REM * rem;
  const inner = Math.max(0, width - 5 * rem);
  return [ref, (tileRem) => Math.max(1, Math.floor((inner + gap) / (tileRem * rem + gap)))];
}
