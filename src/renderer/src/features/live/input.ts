// Input helpers that keep the guide responsive to keyboard, mouse and trackpad at the same time.
import { useCallback, useRef, type MouseEvent, type WheelEvent } from "react";
import type { LiveChannel } from "../../../../shared/library.ts";

/**
 * True only when the pointer really moved. Chromium sends synthetic mouse moves when a list
 * scrolls under a resting pointer; treating those as hover would pull the highlight away from
 * the keyboard. One highlight follows whichever input moved last, as in T3 Code's lists.
 */
export function usePointerIntent(): (event: MouseEvent) => boolean {
  const last = useRef<{ x: number; y: number } | null>(null);
  return useCallback((event: MouseEvent) => {
    const previous = last.current;
    last.current = { x: event.screenX, y: event.screenY };
    return previous !== null && (previous.x !== event.screenX || previous.y !== event.screenY);
  }, []);
}

/** Keeps focus where it is when a control is clicked, so the arrow keys keep driving the guide. */
export function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

/** Accumulated wheel distance, in px, that counts as a deliberate swipe. */
const SWIPE_DISTANCE = 70;
/** A pause this long between wheel events ends the gesture. */
const SWIPE_END_MS = 180;

/**
 * Recognises two-finger trackpad swipes: one callback per gesture, however long the fingers keep
 * moving. `horizontal` gets -1 for a swipe to the right (reveal from the left) and 1 to the left.
 */
export function useSwipe(handlers: {
  horizontal?: (direction: -1 | 1) => void;
  vertical?: (direction: -1 | 1) => void;
}): (event: WheelEvent) => void {
  const gesture = useRef({ dx: 0, dy: 0, fired: false, timer: 0 });
  const latest = useRef(handlers);
  latest.current = handlers;
  return useCallback((event: WheelEvent) => {
    if (event.ctrlKey) return;
    const state = gesture.current;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.dx = 0;
      state.dy = 0;
      state.fired = false;
    }, SWIPE_END_MS);
    if (state.fired) return;
    state.dx += event.deltaX;
    state.dy += event.deltaY;
    const { horizontal, vertical } = latest.current;
    if (
      horizontal &&
      Math.abs(state.dx) > SWIPE_DISTANCE &&
      Math.abs(state.dx) > Math.abs(state.dy) * 1.5
    ) {
      state.fired = true;
      horizontal(state.dx < 0 ? -1 : 1);
    } else if (
      vertical &&
      Math.abs(state.dy) > SWIPE_DISTANCE &&
      Math.abs(state.dy) > Math.abs(state.dx) * 1.5
    ) {
      state.fired = true;
      vertical(state.dy < 0 ? -1 : 1);
    }
  }, []);
}

/** The channel `delta` steps from `currentId` in `list`, wrapping around like channel up and down. */
export function adjacentChannel(
  list: readonly LiveChannel[],
  currentId: string | null | undefined,
  delta: number,
): LiveChannel | undefined {
  if (list.length === 0) return undefined;
  const index = list.findIndex((channel) => channel.id === currentId);
  if (index === -1) return delta > 0 ? list[0] : list[list.length - 1];
  return list[(index + delta + list.length) % list.length];
}
