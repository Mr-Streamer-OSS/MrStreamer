import { store } from "../platform/store.ts";

/** What an example was asked to do; the Add provider sheet is titled for it. */
export type ProviderAction = "play" | "download" | "cast" | "remind" | "save";

/** In-memory browsing admission only. Never persisted or installed in the source roster. */
export const preview = store(false);

/**
 * The sheet for an action that needs a provider, `"add"` for the real Add provider form over the
 * preview, or null while neither shows.
 */
export const providerPrompt = store<ProviderAction | "add" | null>(null);
export const exampleId = "example:627";
export const isExample = (id: string) => id === exampleId || id.startsWith(`${exampleId}:`);

export function enterPreview() {
  providerPrompt.set(null);
  preview.set(true);
}

export function exitPreview() {
  providerPrompt.set(null);
  preview.set(false);
}

/** All example actions stop here, including stale links after leaving preview. */
export function providerRequired(action: ProviderAction, identity?: string): boolean {
  if (!preview.get() && (!identity || !isExample(identity))) return false;
  providerPrompt.set(action);

  return true;
}
