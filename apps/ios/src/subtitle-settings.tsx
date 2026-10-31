import { SymbolView } from "expo-symbols";
import { ActionSheetIOS, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  SUBTITLE_SIZES,
  updateMediaPreferences,
  useMediaPreferences,
  type SubtitleSize,
} from "./media-preferences.ts";
import { removeSubtitleKey, saveSubtitleKey, useSubtitleKey } from "./online-subtitles.ts";
import { colors } from "./ui.tsx";

/**
 * Settings' Subtitles section: the viewer's own SubDL API key, which Watch's Find online searches
 * with, shown only as saved or not, and the size downloaded subtitles show at. Mounted in Settings
 * under Media, in its rows' style.
 */
export function SubtitleSettings() {
  const key = useSubtitleKey();
  const { subtitleSize } = useMediaPreferences();
  return (
    <>
      <Text style={styles.section} accessibilityRole="header">
        Subtitles
      </Text>
      <Row
        label="SubDL API key"
        value={key === null ? undefined : key ? "Saved" : "Not set"}
        // Until the Keychain answers, whether there is one to replace isn't known.
        onPress={key === null ? undefined : key ? manageKey : enterKey}
        testID="settings-subdl-key"
      />
      <Row
        label="Text size"
        value={sizeNames[subtitleSize]}
        onPress={chooseSize}
        testID="settings-subtitle-size"
      />
      <Text style={styles.paragraph}>
        Find online in Watch searches SubDL with your own key. Text size is for downloaded
        subtitles.
      </Text>
    </>
  );
}

const sizeNames: Readonly<Record<SubtitleSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Asks for a key, never showing one saved: an empty entry saves nothing. */
function enterKey() {
  Alert.prompt(
    "SubDL API key",
    "From your account on subdl.com.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Save",
        onPress: (typed = "") => {
          if (!typed.trim()) return;
          saveSubtitleKey(typed).catch(() =>
            Alert.alert("Couldn't save the key", "The Keychain refused it. Try again."),
          );
        },
      },
    ],
    "secure-text",
  );
}

/** A saved key can be replaced, typed again in full, or removed. */
function manageKey() {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: "SubDL API key",
      options: ["Replace", "Remove", "Cancel"],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    },
    (index) => {
      if (index === 0) enterKey();
      else if (index === 1) {
        removeSubtitleKey().catch(() =>
          Alert.alert("Couldn't remove the key", "It's still saved. Try again."),
        );
      }
    },
  );
}

function chooseSize() {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: "Text size",
      options: [...SUBTITLE_SIZES.map((size) => sizeNames[size]), "Cancel"],
      cancelButtonIndex: SUBTITLE_SIZES.length,
    },
    (index) => {
      const size = SUBTITLE_SIZES[index];
      if (size && !updateMediaPreferences("subtitleSize", size)) {
        Alert.alert(
          "Couldn't save media preference",
          "Your previous choice is still saved. Try again.",
        );
      }
    },
  );
}

/** A row that opens a sheet or prompt, as Settings' own rows do. */
function Row({
  label,
  value,
  onPress,
  testID,
}: {
  label: string;
  value: string | undefined;
  onPress: (() => void) | undefined;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
      <View style={styles.opens}>
        {value ? <Text style={styles.value}>{value}</Text> : null}
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 24,
    marginBottom: 4,
    marginHorizontal: 16,
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    alignItems: "center",
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.5 },
  label: { color: colors.text, fontSize: 17, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  opens: { flexDirection: "row", alignItems: "center", gap: 8 },
  paragraph: {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 4,
  },
});
