// The interface language in the window. The main process owns the choice and what it resolves
// to; the window shows its text in that language from the first paint, and again in another as
// soon as Settings changes it, without reloading: what plays goes on playing.
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { InterfaceLanguage, LanguageChoice, Locale } from "@mrstreamer/contracts/language";
import { currentLanguage, onLanguageChange, setLanguage } from "@mrstreamer/core/i18n";
import { call } from "../lib/ipc.ts";
import { queries } from "../lib/queries.ts";

/** Shows the window's text in `language`, and tells assistive technology which one it is. */
function applyLanguage(language: InterfaceLanguage): void {
  setLanguage(language);
  document.documentElement.lang = language.locale;
}

/** Reads the language before the first paint. English when the main process can't say. */
export async function loadLanguage(client: QueryClient): Promise<void> {
  try {
    const language = await call("language.get");
    client.setQueryData(queries.language().queryKey, language);
    applyLanguage(language);
  } catch {
    // English, as before the main process answers.
  }
}

/**
 * The interface language, rendering the caller again when it changes. The root uses it, so every
 * component below renders its text in the new language; text kept in a memo names it among the
 * memo's inputs.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(onLanguageChange, currentLanguage).locale;
}

/**
 * Saves `choice` and shows the window in it. What the main process wrote in the old language,
 * such as collection names, is asked for again.
 */
export async function changeLanguage(client: QueryClient, choice: LanguageChoice): Promise<void> {
  const language = await call("language.set", { choice });
  client.setQueryData(queries.language().queryKey, language);
  applyLanguage(language);
  await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "language" });
}
