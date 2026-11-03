import { usePathname } from "expo-router";
import { sources } from "../bootstrap/sources.ts";
import { useEffect, useSyncExternalStore } from "react";
import { Button, Modal, Text, View } from "react-native";
import { statistics } from "../telemetry/index.ts";
import { t } from "./copy.ts";
import { useInterfaceLanguage } from "./language.ts";

/** Initial explicit choice. Back and the scrim cannot grant or dismiss consent. */
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

  return (
    <Modal visible={record.choice === null} transparent={false} onRequestClose={() => {}}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <Text style={{ color: "#FFFFFF" }}>{t("Help improve Mr. Streamer")}</Text>
        <Text style={{ color: "#FFFFFF" }}>
          {t("Counts app use, the screens you open and provider actions.")}
        </Text>
        <Text style={{ color: "#FFFFFF" }}>
          {t("No viewing history, searches or provider details. Off until you choose to share.")}
        </Text>
        {!statistics.consent.available ? (
          <Text style={{ color: "#FFFFFF" }}>
            {t("They can't be saved on this phone right now.")}
          </Text>
        ) : null}
        <Button title={t("Don't share")} onPress={() => statistics.configure(false)} />
        <Button title={t("Share")} onPress={() => statistics.configure(true)} />
      </View>
    </Modal>
  );
}
