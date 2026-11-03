import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { useStore } from "../platform/store.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { build } from "./build.ts";
import { t } from "./copy.ts";
import { diagnosticsText } from "./diagnostics.ts";
import { PaneTitle } from "./pane-title.tsx";
import { Pressed } from "./parts.tsx";

/**
 * Settings' Diagnostics pane: the text `diagnosticsText` makes, in English as the iOS app's is,
 * and Share, which hands the system share sheet that text alone. Beside its list (`beside`) it
 * carries its own title with Share; over it, the top app bar carries the title and Share leads
 * the text. Paper A: 360dp beside, 24dp margins and 12/18 mono text; 16dp and 13/19 over it.
 */
export function DiagnosticsPane({
  beside,
  onShareFailed,
}: {
  beside: boolean;
  onShareFailed: () => void;
}) {
  const state = useStore(sources.state);
  // When it opened, so what it shows is what Share sends.
  const [now] = useState(Date.now);
  const insets = useSafeAreaInsets();

  const text = diagnosticsText({
    version: build.version,
    build: build.code,
    release: build.release,
    api: build.api,
    sources: state,
    now,
  });

  const share = () => void Share.share({ message: text }).catch(onShareFailed);
  const margin = beside ? 24 : 16;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {beside ? (
        <PaneTitle title={t("Diagnostics")}>
          <IconButton icon="share" label={t("Share")} onPress={share} />
        </PaneTitle>
      ) : null}
      <Text
        style={{
          paddingTop: beside ? 0 : 8,
          paddingBottom: beside ? 16 : 8,
          paddingHorizontal: margin,
          color: colors.secondary,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {t(
          "Shared exactly as below. Left out: provider addresses, logins and names, viewing history and file paths.",
        )}
      </Text>
      {beside ? null : (
        <Pressed onPress={share} label={t("Share")} minHeight={48} style={{ marginBottom: 8 }}>
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name="share"
            size={24}
            color={colors.text}
          />
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}>
            {t("Share")}
          </Text>
        </Pressed>
      )}
      <View style={{ paddingHorizontal: margin }}>
        <Text
          selectable
          style={{
            color: colors.text,
            fontFamily: "monospace",
            fontSize: beside ? 12 : 13,
            lineHeight: beside ? 18 : 19,
          }}
        >
          {text}
        </Text>
      </View>
    </ScrollView>
  );
}
