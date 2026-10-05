// Platform differences the UI has to draw around.
import { useSyncExternalStore } from "react";
import { listen } from "../lib/ipc.ts";

const userAgent = navigator.userAgent;

export const isMac = userAgent.includes("Mac OS X");
export const isWindows = userAgent.includes("Windows");

/** True when the platform's main modifier (⌘ on macOS, Ctrl elsewhere) is held. */
export function hasModifier(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** True while the user types into a field, so single-key shortcuts stay out of the way. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** How long to wait for the window's word on full screen before going on without it. */
const FULL_SCREEN_MS = 2000;

let fullScreen = false;
const fullScreenListeners = new Set<() => void>();
listen("window.fullScreen", (value) => {
  fullScreen = value;
  for (const listener of fullScreenListeners) listener();
});

/**
 * Resolves once the window fills the screen, or once it no longer does, as `wanted` says. The
 * page's own request for full screen, or to leave it, is answered within a millisecond, while
 * macOS takes over half a second more to get the window there, and the window changes size on
 * the way. So what depends on where the window ends up waits for the main process's word. A
 * window that never gives it, as one the system keeps from full screen, is waited for no longer
 * than `FULL_SCREEN_MS`.
 */
export function windowFullScreen(wanted: boolean): Promise<void> {
  if (fullScreen === wanted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      fullScreenListeners.delete(heard);
      clearTimeout(timer);
      resolve();
    };
    const heard = () => {
      if (fullScreen === wanted) done();
    };
    const timer = setTimeout(done, FULL_SCREEN_MS);
    fullScreenListeners.add(heard);
  });
}

/** Whether the window fills the screen, where the system hides its window controls. */
export function useWindowFullScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      fullScreenListeners.add(onChange);
      return () => fullScreenListeners.delete(onChange);
    },
    () => fullScreen,
  );
}
