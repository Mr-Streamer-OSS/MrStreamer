import { t } from "../../../settings/copy.ts";
import { currentLanguage, onLanguageChange } from "@mrstreamer/core/i18n";
import { useSyncExternalStore } from "react";
import { Screen } from "../../../navigation/screen.tsx";

/** Settings, opened over any destination's stack (`hrefOn`); the other destinations' routes reuse it. */
export default function Settings() {
  useSyncExternalStore(onLanguageChange, currentLanguage);

  return <Screen title={t("Settings")} pushed />;
}
