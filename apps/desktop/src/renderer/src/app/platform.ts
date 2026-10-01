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

let fullScreen = false;
const fullScreenListeners = new Set<() => void>();
listen("window.fullScreen", (value) => {
  fullScreen = value;
  for (const listener of fullScreenListeners) listener();
});

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
