import { downloads } from "../../downloads/runtime.ts";
import { t } from "../../downloads/copy.ts";
import { useLocale } from "../../library/catalogue.ts";
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
  useLocale();
  const state = useStore(player.state);
  const copy = state.kind === "playing" && state.intent.kind === "file" ? state.intent : null;
  const failed = copy && state.kind === "playing" && state.failure ? copy : null;

  async function remove(path: string) {
    await player.stop();
    const owner = downloads();

    for (const row of owner.state.get().rows) {
      if ((await owner.native.filePath(row.id)) === path) await owner.command(row, "remove");
    }
  }

  return (
    <>
      <Watch />
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
