import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, Text, TextInput, View } from "react-native";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import { describeFailure } from "./failure.ts";
import type { SourcesOwner } from "./sources.ts";

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

  const field = (key: keyof LoginInput, label: string, secret = false) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor="#9e9e9e"
      value={input[key]}
      onChangeText={(text) => setInput((now) => ({ ...now, [key]: text }))}
      secureTextEntry={secret}
      autoCapitalize="none"
      autoCorrect={false}
      editable={!busy}
      style={{
        color: "#ffffff",
        fontSize: 16,
        minHeight: 48,
        borderBottomWidth: 1,
        borderColor: "#424242",
      }}
    />
  );

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text
        accessibilityRole="header"
        style={{ color: "#ffffff", fontSize: 22, fontWeight: "700" }}
      >
        Add provider
      </Text>
      {field("server", "Server or M3U link")}
      {field("username", "Username")}
      {field("password", "Password", true)}
      {failure ? (
        <Text accessibilityLiveRegion="polite" style={{ color: "#ffffff" }}>
          {describeFailure(failure.error)}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void connect(input)}
        style={{ minHeight: 48, justifyContent: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 16, fontWeight: "700" }}>
          {busy ? "Connecting…" : "Connect"}
        </Text>
      </Pressable>
      {failure?.http ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => failure.http && void connect(failure.http)}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Text style={{ color: "#ffffff", fontSize: 16 }}>Connect without encryption (http)</Text>
        </Pressable>
      ) : null}
      {onDone ? (
        <Pressable
          accessibilityRole="button"
          onPress={onDone}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Text style={{ color: "#ffffff", fontSize: 16 }}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
