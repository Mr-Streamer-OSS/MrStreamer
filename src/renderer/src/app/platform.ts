// Platform differences the UI has to draw around.
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
