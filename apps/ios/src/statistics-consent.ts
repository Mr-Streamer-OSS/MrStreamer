import { Alert } from "react-native";
import { t } from "./i18n/onboarding.ts";
import { setStatistics, statisticsChoice } from "./telemetry/index.ts";

/** Both answers continue even when storage refuses the choice; statistics then remain off. */
export function requestStatisticsChoice(onDone?: () => void): void {
  if (statisticsChoice() !== null) {
    onDone?.();
    return;
  }
  const choose = (enabled: boolean) => {
    setStatistics(enabled);
    onDone?.();
  };
  Alert.alert(
    t("Share usage statistics?"),
    t(
      "Help improve Mr. Streamer by sharing app activity, playback duration and error types with a random app identifier.\n\nNo titles, channel names, search text or provider details.\n\nYou can change this in Settings.",
    ),
    [
      { text: t("Don't share"), onPress: () => choose(false) },
      { text: t("Share"), onPress: () => choose(true) },
    ],
    { cancelable: false },
  );
}
