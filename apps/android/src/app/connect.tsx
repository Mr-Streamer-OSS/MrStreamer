import { useEffect, useState } from "react";
import { Pressable, Text } from "react-native";
import { router } from "expo-router";
import { t } from "../downloads/copy.ts";
import { SafeAreaView } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { colors } from "../ui/theme.ts";

/** The first source. Once it is saved the root layout shows the destinations in its place. */
export default function Connect() {
  const [hasDownloads, setHasDownloads] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("../downloads/runtime.ts")
      .then(({ downloads }) => {
        if (disposed) return;
        const owner = downloads();

        const update = () =>
          setHasDownloads(owner.state.get().rows.length > 0 || owner.state.get().error !== null);

        const unsubscribe = owner.state.subscribe(update);
        const stop = owner.start();
        cleanup = () => {
          unsubscribe();
          stop();
        };

        update();
      })
      .catch(() => {});

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    // Edge to edge: Connect pads its own scrolling content above the navigation bar.
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ConnectScreen
        owner={sources}
        onConnected={() => {}}
        footer={
          hasDownloads ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/offline")}
              style={{ minHeight: 48, padding: 16 }}
            >
              <Text style={{ color: "white" }}>{t("Downloads")}</Text>
            </Pressable>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
