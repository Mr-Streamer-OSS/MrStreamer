import { useEffect, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { t } from "../downloads/copy.ts";
import { Icon, Press } from "../library/parts.tsx";
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
            // As Connect's own action rows: a 24dp icon 16dp before its 16sp label.
            <Press
              label={t("Downloads")}
              onPress={() => router.push("/offline")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 16,
                minHeight: 48,
                marginTop: 8,
                paddingHorizontal: 16,
              }}
            >
              <Icon name="download" />
              <Text
                style={{
                  flex: 1,
                  color: colors.text,
                  fontSize: 16,
                  lineHeight: 20,
                  fontWeight: "500",
                }}
              >
                {t("Downloads")}
              </Text>
            </Press>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
