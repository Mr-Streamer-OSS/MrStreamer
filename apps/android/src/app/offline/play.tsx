import { providerRequired } from "../../preview/session.ts";
import { downloads } from "../../downloads/runtime.ts";
import { t } from "../../downloads/copy.ts";
import { router, useIsFocused } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { currentLanguage, onLanguageChange } from "@mrstreamer/mobile/language";
import { Dialog, RED, TextButton } from "../../live/chrome.tsx";
import { player } from "../../player/instance.ts";
import { useStore } from "../../platform/store.ts";
import { colors } from "../../ui/theme.ts";
import Watch from "../watch.tsx";

/**
 * A saved copy on A's one player, outside the provider guards. Watch leaves once playback stops.
 * A copy that can't be read stops with Delete download or OK and never resolves a provider stream.
 */
export default function OfflinePlay() {
  useSyncExternalStore(onLanguageChange, currentLanguage);
  const state = useStore(player.state);

  const local = state.kind === "playing" && state.intent.kind === "file";
  const shown = useRef(local);
  const exited = useRef(false);
  const focused = useIsFocused();
  const refused = !local && (!shown.current || state.kind === "playing");

  if (local) shown.current = true;
  useEffect(() => {
    if (local) exited.current = false;

    if (focused && refused && !exited.current) {
      exited.current = true;
      router.replace("/offline");
    }
  }, [local, focused, refused]);

  const failed =
    state.kind === "playing" &&
    state.intent.kind === "file" &&
    (state.failure?.kind === "resolve" ||
      (state.failure?.kind === "native" && state.failure.failure.kind === "file-missing"))
      ? state.intent
      : null;

  async function remove(path: string) {
    if (providerRequired("download")) return;
    await player.stop();
    const owner = downloads();

    for (const row of owner.state.get().rows) {
      if ((await owner.native.filePath(row.id)) === path) {
        const refusal = await owner.command(row, "remove");

        if (refusal)
          Alert.alert(
            t("Couldn't remove {name}", { name: row.title }),
            t(
              refusal === "playing"
                ? "Stop playing this copy first."
                : "The old copy is still closing. Try again.",
            ),
          );
      }
    }
  }

  if (refused) return null;

  return (
    <>
      <Watch offline />
      {failed ? (
        <Dialog
          title={t("Couldn't play {name}", { name: failed.title })}
          body={t("The copy on this device can't be read. Delete it and download it again.")}
          onClose={() => void player.stop()}
          actions={
            <>
              <TextButton
                label={t("Delete download")}
                strong
                color={RED}
                onPress={() => void remove(failed.path)}
              />
              <TextButton
                label={t("OK")}
                strong
                color={colors.text}
                onPress={() => void player.stop()}
              />
            </>
          }
        />
      ) : null}
    </>
  );
}
