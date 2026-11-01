import { useNavigation, type NativeStackNavigationOptions } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Text } from "react-native";
import { diagnosticsText } from "../../../diagnostics.ts";
import { useLocale } from "../../../i18n/catalogue.ts";
import { t } from "../../../i18n/pages.ts";
import { colors } from "../../../ui.tsx";

/**
 * Settings' Diagnostics: the text `diagnosticsText()` reads as the screen opens, shown as plain
 * monospace lines, and Share in the top bar, which hands the system's share sheet exactly that
 * text and nothing else. Nothing is sent unless the viewer shares it. The screen's own words follow
 * the interface language; the text stays English, for whoever the viewer shares it with.
 */
export default function Diagnostics() {
  const navigation = useNavigation();
  const [text] = useState(diagnosticsText);
  const locale = useLocale();
  useLayoutEffect(() => {
    const share = () =>
      void Share.share({ message: text }).catch(() =>
        Alert.alert(t("Couldn't share diagnostics"), t("Try again.")),
      );
    navigation.setOptions({
      title: t("Diagnostics"),
      // Only Share: what the top bar offers elsewhere would leave the text unshared.
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: t("Share"),
          icon: { type: "sfSymbol", name: "square.and.arrow.up" },
          onPress: share,
        },
      ],
    } satisfies NativeStackNavigationOptions);
  }, [navigation, text, locale]);
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Text style={styles.intro}>
        {t(
          "Shared exactly as below. Left out: provider addresses, logins and names, viewing history and file paths.",
        )}
      </Text>
      <Text style={styles.text} selectable testID="diagnostics-text">
        {text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  intro: {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 16,
  },
  text: {
    color: colors.text,
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 19,
    marginHorizontal: 16,
    marginBottom: 32,
  },
});
