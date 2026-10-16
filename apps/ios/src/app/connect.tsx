import { router } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { connect, useSession } from "../account.ts";
import { appError, failureOf, type Failure } from "../errors.ts";
import { colors, TextButton } from "../ui.tsx";

/**
 * Signs in to an Xtream subscription, on one form. A failure keeps every field and says what
 * happened and what to do; Connect becomes Try again with the same details until a field changes,
 * which clears the failure. The root layout shows the tabs once it is signed in.
 */
export default function Connect() {
  const session = useSession();
  const saved = session.kind === "signed-out" ? session.saved : null;
  const [server, setServer] = useState(saved?.server ?? "");
  const [username, setUsername] = useState(saved?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The line under the fields. `tried` when it is the failure of the details as they stand: the
  // button says Try again, and an edit clears it. The saved login's prompt stays until Connect.
  const [notice, setNotice] = useState<{ failure: Failure; tried: boolean } | null>(
    saved
      ? { failure: { headline: "Enter the password again.", advice: null }, tried: false }
      : null,
  );
  // Counts edits, so a sign-in that fails after the fields changed says nothing about them.
  const edits = useRef(0);
  // The keyboard's Go submits too, and can before `busy` renders: one sign-in at a time.
  const pending = useRef(false);

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    edits.current += 1;
    setNotice((shown) => (shown?.tried ? null : shown));
  };

  const submit = () => {
    if (pending.current) return;
    pending.current = true;
    const submitted = edits.current;
    setBusy(true);
    setNotice(null);
    connect({ server, username, password }).catch((cause: unknown) => {
      pending.current = false;
      setBusy(false);
      if (edits.current !== submitted) return;
      setNotice({ failure: failureOf(appError(cause), server), tried: true });
    });
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <View>
        <Text style={styles.title} accessibilityRole="header">
          Mr. Streamer
        </Text>
        <Text style={styles.lead}>Add your provider</Text>
      </View>
      <Field
        label="Server"
        value={server}
        onChange={edit(setServer)}
        placeholder="http://line.example.com:8080"
        keyboard="url"
      />
      <Field label="Username" value={username} onChange={edit(setUsername)} />
      <Field
        label="Password"
        value={password}
        onChange={edit(setPassword)}
        secret
        onSubmit={submit}
      />
      {notice ? (
        <View accessible accessibilityLiveRegion="polite" testID="connect-error">
          <Text style={styles.error}>{notice.failure.headline}</Text>
          {notice.failure.advice ? (
            <Text style={styles.advice}>{notice.failure.advice}</Text>
          ) : null}
        </View>
      ) : null}
      <TextButton
        label={busy ? "Connecting" : notice?.tried ? "Try again" : "Connect"}
        onPress={submit}
        disabled={busy}
      />
      <Text style={styles.footnote}>The password stays in this iPhone's Keychain.</Text>
      {__DEV__ ? <TextButton label="Runtime proof" onPress={() => router.push("/proof")} /> : null}
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  keyboard,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
  keyboard?: "url";
  onSubmit?: () => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#636366"
        secureTextEntry={secret ?? false}
        textContentType={secret ? "password" : keyboard ? "URL" : "username"}
        keyboardType={keyboard === "url" ? "url" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType={onSubmit ? "go" : "next"}
        onSubmitEditing={onSubmit}
        style={styles.input}
        testID={`connect-${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 24, gap: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  lead: { color: colors.text, fontSize: 17, marginTop: 4, marginBottom: 8 },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 15, fontWeight: "600" },
  input: {
    minHeight: 44,
    color: colors.text,
    fontSize: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  error: { color: "#FF453A", fontSize: 15, fontWeight: "600" },
  advice: { color: colors.text, fontSize: 15, marginTop: 2 },
  footnote: { color: colors.dim, fontSize: 13 },
});
