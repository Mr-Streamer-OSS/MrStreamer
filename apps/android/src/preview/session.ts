import { store } from "../platform/store.ts";

/** In-memory browsing admission only. Never persisted or installed in the source roster. */
export const preview = store(false);
export const providerPrompt = store(false);
export const exampleId = "example:627";
export const isExample = (id: string) => id === exampleId || id.startsWith(`${exampleId}:`);

export function enterPreview() {
  providerPrompt.set(false);
  preview.set(true);
}

export function exitPreview() {
  providerPrompt.set(false);
  preview.set(false);
}

/** All example actions stop here, including stale links after leaving preview. */
export function providerRequired(identity?: string): boolean {
  if (!preview.get() && (!identity || !isExample(identity))) return false;
  providerPrompt.set(true);

  return true;
}
