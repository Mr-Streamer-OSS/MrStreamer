import { t } from "@mrstreamer/core/i18n";
import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { RemindersScreen } from "../../../reminders-screen.tsx";

/** The reminders still set (reminders-screen.tsx), pushed on Live's stack, titled here. */
export default function LiveReminders() {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: t("Reminders") });
  }, [navigation]);
  return <RemindersScreen />;
}
