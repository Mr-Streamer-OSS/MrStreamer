import { currentLanguage, onLanguageChange, setLanguage } from "@mrstreamer/core/i18n";
import { resolveAndroidLanguage, type LanguageChoice } from "@mrstreamer/mobile/language/resolve";
import { useSyncExternalStore } from "react";
import { I18nManager } from "react-native";
import { preferences } from "../platform/preferences.ts";

const files = preferences();

const systemTags = () => [
  I18nManager.getConstants().localeIdentifier ?? Intl.DateTimeFormat().resolvedOptions().locale,
];

let saved: string | undefined;

try {
  saved = files.language();
} catch {
  /* Keep English until a choice can be read. */
}

setLanguage(resolveAndroidLanguage(saved, systemTags()));

/** Every screen can use this hook, or core's subscription, to render after a language change. */
export function useInterfaceLanguage() {
  return useSyncExternalStore(onLanguageChange, currentLanguage);
}

export function languageChoice(): LanguageChoice {
  return saved === "nl-NL" || saved === "en-US" ? saved : "system";
}

export function chooseLanguage(choice: LanguageChoice): boolean {
  if (!files.write("language.json", { choice })) return false;
  saved = choice;
  setLanguage(resolveAndroidLanguage(choice, systemTags()));

  return true;
}
