import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { BackHandler, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import { describeFailure } from "./failure.ts";
import type { SourcesOwner } from "./sources.ts";

type IconName = ComponentProps<typeof MaterialIcons>["name"];

const SECONDARY = "#A3A3A3";
const HAIRLINE = "#1C1C1C";

/**
 * Adds a source: an Xtream server with its username and password, or an M3U link in the server
 * field alone. Nothing is saved until the provider accepts it. `onDone`, when given, is where Back
 * and Cancel go; without it (no source saved yet) Back leaves the app as Android does.
 */
export function ConnectScreen({
  owner,
  onDone,
  onConnected,
}: {
  owner: SourcesOwner;
  onDone?: () => void;
  onConnected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState<LoginInput>({ server: "", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: AppError; http: LoginInput | null } | null>(null);
  const attempt = useRef<AbortController | null>(null);

  useEffect(() => () => attempt.current?.abort(), []);
  useEffect(() => {
    if (!onDone) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      onDone();
      return true;
    });
    return () => back.remove();
  }, [onDone]);

  async function connect(login: LoginInput) {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setFailure(null);
    const result = await owner.connect(login, controller.signal);
    if (controller.signal.aborted) return;
    setBusy(false);
    if (result.kind === "connected") onConnected();
    else setFailure({ error: result.error, http: result.http });
  }

  // Fields and actions share one lane: a 24dp icon at 16dp, text at 56dp.
  const field = (key: keyof LoginInput, label: string, icon: IconName, secret = false) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingLeft: 16,
        paddingRight: 16,
        borderBottomWidth: 1,
        borderColor: HAIRLINE,
      }}
    >
      <MaterialIcons name={icon} size={24} color={SECONDARY} />
      <TextInput
        accessibilityLabel={label}
        placeholder={label}
        placeholderTextColor={SECONDARY}
        value={input[key]}
        onChangeText={(text) => setInput((now) => ({ ...now, [key]: text }))}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        style={{ flex: 1, minHeight: 48, color: "#FFFFFF", fontSize: 16, padding: 0 }}
      />
    </View>
  );

  const action = (label: string, icon: IconName, onPress: () => void, primary = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 48,
        paddingLeft: 16,
        paddingRight: 16,
      }}
    >
      <MaterialIcons name={icon} size={24} color={busy ? SECONDARY : "#FFFFFF"} />
      <Text
        style={{
          flex: 1,
          color: busy ? SECONDARY : "#FFFFFF",
          fontSize: 16,
          lineHeight: 20,
          fontWeight: primary ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 64,
          paddingLeft: onDone ? 4 : 16,
          paddingRight: 4,
          gap: 4,
        }}
      >
        {onDone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onDone}
            style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
          >
            <MaterialIcons name="close" size={24} color="#FFFFFF" />
          </Pressable>
        ) : null}
        <Text
          accessibilityRole="header"
          style={{
            flex: 1,
            color: "#FFFFFF",
            fontSize: 22,
            lineHeight: 28,
            fontWeight: "700",
            letterSpacing: -0.22,
          }}
        >
          Add provider
        </Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        {field("server", "Server or M3U link", "link")}
        {field("username", "Username", "person-outline")}
        {field("password", "Password", "lock-outline", true)}
        {failure ? (
          <View
            accessible
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", gap: 16, paddingHorizontal: 16, paddingVertical: 14 }}
          >
            <MaterialIcons name="error-outline" size={24} color="#FFFFFF" />
            <Text
              style={{ flex: 1, color: "#FFFFFF", fontSize: 14, lineHeight: 20, paddingTop: 2 }}
            >
              {describeFailure(failure.error)}
            </Text>
          </View>
        ) : null}
        <View style={{ paddingTop: failure ? 0 : 8 }}>
          {action(busy ? "Connecting" : "Connect", "login", () => void connect(input), true)}
          {failure?.http
            ? action("Connect without encryption (http)", "no-encryption", () => {
                if (failure.http) void connect(failure.http);
              })
            : null}
        </View>
      </ScrollView>
    </View>
  );
}
