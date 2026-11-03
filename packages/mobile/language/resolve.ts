import { resolveLanguage } from "@mrstreamer/core/i18n";

export type LanguageChoice = "system" | "en-US" | "nl-NL";

/** Resolve against core, restricting both saved and system languages to Android's catalogues. */
export function resolveAndroidLanguage(saved: string | undefined, tags: readonly string[]) {
  const supported = tags.filter((tag) => /^(en|nl)(?:[-_]|$)/i.test(tag));

  return resolveLanguage(
    saved === undefined || saved === "system" || saved === "nl-NL" || saved === "en-US"
      ? saved
      : "en-US",
    supported,
  );
}
