import type { InterfaceLanguage, LanguageChoice } from "@mrstreamer/contracts/language";
import { resolveLanguage, setLanguage } from "@mrstreamer/core/i18n";
import { Settings } from "react-native";
import { readJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// The interface language on iOS: the choice Settings saved in language.json, resolved by core's
// rules against the iPhone's preferred languages, so System default is the first of them the app
// speaks, else English. It applies when this module first loads, before Connect or the tabs
// render (both import it), and again when Settings changes it, without a relaunch. iOS relaunches
// the app when the iPhone's languages change, so System default is resolved once per launch.

const FILE = "language.json";

/** The iPhone's preferred languages, best first, as iOS lists them for this app. */
function systemTags(): readonly string[] {
  const preferred: unknown = Settings.get("AppleLanguages");
  const tags = Array.isArray(preferred)
    ? preferred.filter((tag): tag is string => typeof tag === "string")
    : [];
  return tags.length > 0 ? tags : [Intl.DateTimeFormat().resolvedOptions().locale];
}

/** What Settings saved: a locale, "system", or a value a later release wrote, which shows English. */
function savedChoice(): string | undefined {
  const saved = readJson(FILE);
  const choice =
    typeof saved === "object" && saved !== null && "choice" in saved ? saved.choice : undefined;
  return typeof choice === "string" ? choice : undefined;
}

const language = store(resolveLanguage(savedChoice(), systemTags()));
setLanguage(language.get());

/** The interface language in effect, and what Settings chose. */
export function useInterfaceLanguage(): InterfaceLanguage {
  return useStore(language);
}

/**
 * Saves `choice` and shows the app in it. False when it couldn't be saved: the language stays as
 * it was, as it would after a relaunch.
 */
export function chooseLanguage(choice: LanguageChoice): boolean {
  try {
    writeJson(FILE, { choice });
  } catch {
    return false;
  }
  const next = resolveLanguage(choice, systemTags());
  setLanguage(next);
  language.set(next);
  return true;
}
