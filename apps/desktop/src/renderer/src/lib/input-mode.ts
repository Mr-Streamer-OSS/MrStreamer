// Which input moved last. Lists keep one keyboard selection, and only the keyboard moves it or
// scrolls a list to it; the pointer only hovers. The selection shows while the keyboard is in use.
import { create } from "zustand";

const KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Tab",
]);

const useMode = create<{ keyboard: boolean }>(() => ({ keyboard: false }));

window.addEventListener("keydown", (event) => {
  if (KEYS.has(event.key) && !useMode.getState().keyboard) useMode.setState({ keyboard: true });
});
// Real movement only: Chromium also sends mouse moves when content scrolls under a still pointer.
window.addEventListener("mousemove", (event) => {
  if ((event.movementX !== 0 || event.movementY !== 0) && useMode.getState().keyboard) {
    useMode.setState({ keyboard: false });
  }
});

/** True while the keyboard was used last, so lists show their selection. */
export function useKeyboardMode(): boolean {
  return useMode((state) => state.keyboard);
}
