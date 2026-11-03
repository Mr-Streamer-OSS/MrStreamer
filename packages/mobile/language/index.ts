/** Each feature owns its catalogue file and complete en-US/nl-NL text. Missing Dutch keys fail
 * compilation. React screens subscribe with useSyncExternalStore(onLanguageChange, currentLanguage)
 * to update without a relaunch. Dates and numbers use core's formatDate and formatNumber. */
export { catalogue } from "./catalogue.ts";

export { resolveAndroidLanguage, type LanguageChoice } from "./resolve.ts";

export {
  currentLanguage,
  onLanguageChange,
  setLanguage,
  formatDate,
  formatNumber,
} from "@mrstreamer/core/i18n";

export type AndroidLocale = "en-US" | "nl-NL";
