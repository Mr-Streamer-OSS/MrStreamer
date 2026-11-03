import { useEffect } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { PlayerSurface } from "../../player/surface.ts";
import { player } from "../../player/instance.ts";
import { useStore } from "../../platform/store.ts";
import { downloads } from "../../downloads/runtime.ts";
import { t } from "../../downloads/copy.ts";

/** A file-only player outside source guards. A failed copy never resolves a provider intent. */
export default function OfflinePlay() {
  const state = useStore(player.state);
  useEffect(() => {
    if (state.kind !== "playing" || state.intent.kind !== "file" || !state.failure) return;
    Alert.alert(t("This copy can’t be read."), undefined, [
      {
        text: t("Delete download"),
        style: "destructive",
        onPress: () => {
          void (async () => {
            if (state.intent.kind !== "file") return;
            const path = state.intent.path;
            await player.stop();
            const owner = downloads();

            for (const row of owner.state.get().rows) {
              if ((await owner.native.filePath(row.id)) === path)
                await owner.command(row, "remove");
            }

            router.back();
          })();
        },
      },
      {
        text: t("OK"),
        onPress: () => {
          void player.stop();
          router.back();
        },
      },
    ]);
  }, [state]);

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <PlayerSurface style={{ flex: 1 }} />
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          void (state.kind === "playing" && state.phase === "paused"
            ? player.resume()
            : player.pause())
        }
        style={{ padding: 16 }}
      >
        <Text style={{ color: "white" }}>
          {t(state.kind === "playing" && state.phase === "paused" ? "Resume" : "Pause")}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void player.stop();
          router.back();
        }}
        style={{ padding: 16 }}
      >
        <Text style={{ color: "white" }}>{t("OK")}</Text>
      </Pressable>
    </View>
  );
}
