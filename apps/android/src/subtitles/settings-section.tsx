import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useStore } from "../platform/store.ts";
import { subtitles, subtitleTextSize, readSubtitleTextSize } from "./runtime.ts";

/** Unmounted handoff: the designer supplies key/size dialogs; Settings mounts this after its handoff. */
export function SubtitleSettingsSection({
  onKey,
  onTextSize,
}: {
  onKey: (saved: boolean) => void;
  onTextSize: () => void;
}) {
  const model = subtitles();
  const state = useStore(model.state);
  const size = useStore(subtitleTextSize);
  useEffect(() => {
    void model.readKey();
    readSubtitleTextSize();
  }, [model]);

  return (
    <View style={{ backgroundColor: "#000" }}>
      <Text style={{ color: "#FFF" }}>Subtitles</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => onKey(state.keySaved === true)}
        style={{ minHeight: 48 }}
      >
        <Text style={{ color: "#FFF" }}>SubDL API key</Text>
        <Text style={{ color: "#FFF" }}>
          {state.keySaved === null
            ? "Couldn't read your SubDL key"
            : state.keySaved
              ? "Saved"
              : "Not set"}
        </Text>
      </Pressable>
      {state.keySaved ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => onKey(true)}
            style={{ minHeight: 48 }}
          >
            <Text style={{ color: "#FFF" }}>Replace</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void model.removeKey()}
            style={{ minHeight: 48 }}
          >
            <Text style={{ color: "#FFF" }}>Remove</Text>
          </Pressable>
        </>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onTextSize} style={{ minHeight: 48 }}>
        <Text style={{ color: "#FFF" }}>Text size · {Math.round(size * 100)}%</Text>
      </Pressable>
    </View>
  );
}
