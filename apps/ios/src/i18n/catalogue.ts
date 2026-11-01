import type { Locale } from "@mrstreamer/contracts/language";
import {
  currentLanguage,
  formatNumber,
  type Placeholder,
  type Plural,
} from "@mrstreamer/core/i18n";

// The iOS app's own text, one catalogue per feature area (onboarding.ts, navigation.ts,
// settings.ts), so a later area adds its own file without touching these. Each is keyed by its
// English text, as core's catalogue is, in the language core's `setLanguage` made the active
// one (language.ts sets it at launch and when Settings changes it; a screen renders again for it
// with language.ts's `useInterfaceLanguage`):
//
//   export const t = catalogue({ Settings: "Settings" }, { "nl-NL": { Settings: "Instellingen" }, ... });
//   t("Settings");
//
// Every language must have every message, or the area doesn't compile. {placeholders} and plural
// forms work as core's `t`: a number in a placeholder is written as a count in the language, and
// a message with forms takes `count`.

type English = Readonly<Record<string, string | Plural>>;

/** Another language's text for every English message of an area. */
type Translation<E extends English> = {
  readonly [K in keyof E]: E[K] extends string ? string : Plural;
};

type Params<E extends English, K extends keyof E & string> = E[K] extends string
  ? { readonly [P in Placeholder<K>]: string | number }
  : { readonly [P in Placeholder<K> | "count"]: P extends "count" ? number : string | number };

type Args<E extends English, K extends keyof E & string> = E[K] extends string
  ? [Placeholder<K>] extends [never]
    ? []
    : [params: Params<E, K>]
  : [params: Params<E, K>];

const rules = new Map<Locale, Intl.PluralRules>();

/** An area's `t`: its message for `key` in the interface language. */
export function catalogue<const E extends English>(
  english: E,
  others: { readonly [L in Exclude<Locale, "en-US">]: Translation<E> },
) {
  return <K extends keyof E & string>(key: K, ...[params]: Args<E, K>): string => {
    const { locale } = currentLanguage();
    // The key is English, should a message ever be missing at runtime.
    let text: string | Plural = (locale === "en-US" ? english : others[locale])[key] ?? key;
    const values: Readonly<Record<string, string | number>> = params ?? {};
    if (typeof text !== "string") {
      let plural = rules.get(locale);
      if (!plural) rules.set(locale, (plural = new Intl.PluralRules(locale)));
      text = text[plural.select(Number(values["count"] ?? 0))] ?? text.other;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? formatNumber(value) : value;
    });
  };
}
