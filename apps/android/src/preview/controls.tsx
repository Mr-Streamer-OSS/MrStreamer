import { useEffect, useState } from "react";
import { BackHandler, Text, View } from "react-native";
import { router, useSegments } from "expo-router";
import { sources } from "../bootstrap/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { TextButton } from "../library/parts.tsx";
import { useStore } from "../platform/store.ts";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { exitPreview, preview, providerPrompt } from "./session.ts";

/** Persistent browsing controls; the designer owns their final accepted-Paper arrangement. */
export function PreviewStrip() {
  const browsing = useStore(preview);
  const segments = useSegments();
  useEffect(() => {
    if (!browsing || segments.at(-1) !== "(live)") return;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      exitPreview();
      router.replace("/connect");

      return true;
    });

    return () => subscription.remove();
  }, [browsing, segments]);

  if (!browsing) return null;

  return (
    <View style={{ backgroundColor: colors.background, paddingHorizontal: 16 }}>
      <Text accessibilityRole="header" style={{ color: colors.text }}>
        Preview mode · Fictional examples
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <TextButton label="Add provider" onPress={() => providerPrompt.set(true)} />
        <TextButton
          label="Exit preview"
          onPress={() => {
            exitPreview();
            router.replace("/connect");
          }}
        />
      </View>
    </View>
  );
}

/** Setup is a modal over the mounted browse tree, so Cancel/Back retain its exact context. */
export function ProviderRequiredSheet() {
  const visible = useStore(providerPrompt);
  const [adding, setAdding] = useState(false);

  const close = () => {
    setAdding(false);
    providerPrompt.set(false);
  };

  return (
    <Sheet visible={visible} label="Add provider" onClose={close} fit={!adding}>
      {adding ? (
        <ConnectScreen
          owner={sources}
          onDone={close}
          onConnected={() => {
            close();
            exitPreview();
            router.replace("/");
          }}
        />
      ) : (
        <View style={{ padding: 24 }}>
          <Text style={{ color: colors.text, fontSize: 22 }}>Add provider</Text>
          <Text style={{ color: colors.text }}>
            Examples are for browsing. Add your provider to use this action.
          </Text>
          <TextButton label="Add provider" onPress={() => setAdding(true)} />
          <TextButton label="Cancel" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
