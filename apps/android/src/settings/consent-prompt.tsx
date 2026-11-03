import { usePathname } from "expo-router";
import { sources } from "../bootstrap/sources.ts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { statistics } from "../telemetry/index.ts";
import { t } from "./copy.ts";
import { useInterfaceLanguage } from "./language.ts";
import { Dialog, DialogText } from "./parts.tsx";

/**
 * The first statistics choice, asked over the destinations until it is made. Back and the scrim
 * don't close it, and Don't share and Share carry the same weight. A choice this phone can't keep
 * leaves statistics off, as Settings then says, and isn't asked again until the app starts again.
 */
export default function ConsentPrompt() {
  useInterfaceLanguage();
  const path = usePathname();
  useEffect(() => {
    if (path.endsWith("/settings")) statistics.noteFeature("settings");
    else if (path === "/") statistics.noteFeature("live_tv");
  }, [path]);
  useEffect(() => {
    let previous: number | null = null;

    const observe = () => {
      const now = sources.state.get();

      if (now.kind !== "ready") return;

      if (now.sources.length === 0 && previous !== 0) {
        statistics.discard();
        previous = 0;

        return;
      }

      if (previous !== null && now.sources.length !== previous) {
        statistics.noteAction(
          now.sources.length > previous ? "playlist_added" : "playlist_removed",
        );
      }

      previous = now.sources.length;
    };

    observe();
    void statistics.resume();

    return sources.state.subscribe(observe);
  }, []);
  const record = useSyncExternalStore(statistics.consent.subscribe, statistics.consent.get);
  const [answered, setAnswered] = useState(false);

  const answer = (share: boolean) => {
    setAnswered(true);
    statistics.configure(share);
  };

  return (
    <Dialog
      visible={record.choice === null && !answered}
      title={t("Share usage statistics?")}
      buttons={[
        { label: t("Don't share"), onPress: () => answer(false) },
        { label: t("Share"), onPress: () => answer(true) },
      ]}
    >
      <DialogText>
        {t(
          "Help improve Mr. Streamer by sharing app activity and provider actions with a random app identifier.",
        )}
      </DialogText>
      <DialogText>{t("No titles, channel names, search text or provider details.")}</DialogText>
      <DialogText>{t("You can change this in Settings.")}</DialogText>
    </Dialog>
  );
}
