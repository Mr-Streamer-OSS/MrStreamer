// The language of the app's own text: menus, buttons, messages, labels. Titles, sound and
// subtitles keep their own languages in the preferences.

/** The interface languages, as the Store lists them. English is the source and the fallback. */
export const LOCALES = ["en-US", "nl-NL", "fr-FR", "de-DE", "es-ES"] as const;
export type Locale = (typeof LOCALES)[number];

/** English: the language every message is written in first, and the one a missing one shows in. */
export const SOURCE_LOCALE: Locale = "en-US";

/** A locale, or the system's language when the app speaks it. */
export type LanguageChoice = Locale | "system";

/** Each language by its own name, as the Settings list shows it in every language. */
export const LANGUAGE_NAMES: { readonly [L in Locale]: string } = {
  "en-US": "English",
  "nl-NL": "Nederlands",
  "fr-FR": "Français",
  "de-DE": "Deutsch",
  "es-ES": "Español",
};

/** The interface language in effect, and how it was chosen. */
export interface InterfaceLanguage {
  /** What the viewer picked in Settings. */
  readonly choice: LanguageChoice;
  /** What System default stands for: the system's first language the app speaks, else English. */
  readonly system: Locale;
  /** The language the app shows. */
  readonly locale: Locale;
  /**
   * The BCP 47 tag dates and numbers are written in: the system's own variant of `locale`, such
   * as en-GB or de-AT, when the system uses that language, else `locale`.
   */
  readonly formats: string;
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}
