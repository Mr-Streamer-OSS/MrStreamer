import { type } from "arktype";
import type { Locale } from "@mrstreamer/contracts/language";
import {
  currentLanguage,
  formatNumber,
  onLanguageChange,
  type Placeholder,
  type Plural,
} from "@mrstreamer/core/i18n";
import { useSyncExternalStore } from "react";

// Temporary Android catalogue adapter, using only portable core language state.

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
  others: Partial<{ readonly [L in Exclude<Locale, "en-US">]: Translation<E> }>,
) {
  return <K extends keyof E & string>(key: K, ...[params]: Args<E, K>): string => {
    const { locale } = currentLanguage();

    // The key is English, should a message ever be missing at runtime.
    let text: string | Plural =
      (locale === "en-US" ? english : (others[locale] ?? english))[key] ?? key;

    const values: Readonly<Record<string, string | number>> = params ?? {};

    if (!type.keywords.string.root.allows(text)) {
      let plural = rules.get(locale);

      if (!plural) rules.set(locale, (plural = new Intl.PluralRules(locale)));
      text = text[plural.select(Number(values["count"] ?? 0))] ?? text.other;
    }

    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values[name];

      if (value === undefined) return whole;

      return type.keywords.string.root.allows(value) ? value : formatNumber(value);
    });
  };
}

/** Re-renders a Live screen when the portable interface language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLanguageChange, () => currentLanguage().locale);
}
