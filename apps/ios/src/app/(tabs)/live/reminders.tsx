import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { useLocale } from "../../../i18n/catalogue.ts";
import { t } from "../../../i18n/live.ts";
import { RemindersScreen } from "../../../reminders-screen.tsx";

/** The reminders still set (reminders-screen.tsx), pushed on Live's stack, titled here. */
export default function LiveReminders() {
  const navigation = useNavigation();
  const locale = useLocale();
  useLayoutEffect(() => {
    navigation.setOptions({ title: t("Reminders") });
  }, [navigation, locale]);
  return <RemindersScreen />;
}
