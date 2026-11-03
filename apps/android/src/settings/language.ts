import { currentLanguage, onLanguageChange, setLanguage } from "@mrstreamer/core/i18n";
import { resolveAndroidLanguage, type LanguageChoice } from "@mrstreamer/mobile/language";
import { useSyncExternalStore } from "react";
import { I18nManager } from "react-native";
import { preferences } from "../platform/preferences.ts";

const files = preferences();

const systemTags = () => [
  I18nManager.getConstants().localeIdentifier ?? Intl.DateTimeFormat().resolvedOptions().locale,
];

let saved: string | undefined;
let unavailable = false;
const listeners = new Set<() => void>();
export const languageUnavailable = () => unavailable;

export function retryLanguage() {
  try {
    saved = files.language();
    unavailable = false;
  } catch {
    unavailable = true;
  }

  if (!unavailable) setLanguage(resolveAndroidLanguage(saved, systemTags()));

  for (const listener of listeners) listener();
}

export function useLanguageAvailability() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }, languageUnavailable);
}

try {
  saved = files.language();
} catch {
  // The interface can resolve a fallback, but the row must report the failed read.
  unavailable = true;
}

setLanguage(resolveAndroidLanguage(saved, systemTags()));

/** Every screen can use this hook, or core's subscription, to render after a language change. */
export function useInterfaceLanguage() {
  return useSyncExternalStore(onLanguageChange, currentLanguage);
}

export function languageChoice(): LanguageChoice {
  return saved === undefined || saved === "system"
    ? "system"
    : saved === "nl-NL"
      ? "nl-NL"
      : "en-US";
}

export function chooseLanguage(choice: LanguageChoice): boolean {
  if (!files.write("language.json", { choice })) return false;
  saved = choice;
  unavailable = false;

  for (const listener of listeners) listener();
  setLanguage(resolveAndroidLanguage(choice, systemTags()));

  return true;
}
