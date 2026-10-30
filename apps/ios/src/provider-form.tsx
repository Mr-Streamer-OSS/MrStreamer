import type { AppError } from "@mrstreamer/contracts/errors";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { add, update, type Member } from "./account.ts";
import { appError, failureOf, hostOf, type Failure } from "./errors.ts";
import { colors, TextButton } from "./ui.tsx";

/** Connect adds the first provider, Settings the next ones, and edits a saved one. */
export type FormMode =
  | { readonly kind: "connect" }
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly member: Member };

/** An Xtream login, or a playlist's link alone. */
export type LoginKind = "xtream" | "m3u";

const KINDS = [
  { kind: "xtream", label: "Login" },
  { kind: "m3u", label: "Playlist link" },
] as const satisfies readonly { kind: LoginKind; label: string }[];

const LABELS = {
  connect: { idle: "Connect", busy: "Connecting" },
  add: { idle: "Add", busy: "Adding" },
  edit: { idle: "Save", busy: "Saving" },
} as const;

/**
 * One form for a provider's login or playlist link, which Login and Playlist link switch between
 * when adding. A failure keeps every field and says what happened and what to do; the button
 * becomes Try again with the same details until a field changes, which clears the failure. The
 * provider checks the login or link before anything is saved. Editing changes the name, and the
 * password or link when one is typed: another server or username is another provider, added. A
 * saved playlist's link is never shown back. Leaving the form before its answer cancels it, and
 * nothing is saved. `footnote` goes under the button, for the kind shown.
 */
export function ProviderForm({
  mode,
  onDone,
  footnote,
}: {
  mode: FormMode;
  onDone?: () => void;
  footnote?: (kind: LoginKind) => ReactNode;
}) {
  const saved = mode.kind === "edit" ? mode.member.entry : null;
  const [kind, setKind] = useState<LoginKind>(saved?.kind === "m3u" ? "m3u" : "xtream");
  const [name, setName] = useState(saved?.name ?? "");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  // The line under the fields, when it is the failure of the details as they stand.
  const [failure, setFailure] = useState<Failure | null>(null);
  // Counts edits, so a sign-in that fails after the fields changed says nothing about them.
  const edits = useRef(0);
  // The keyboard's Go submits too, and can before `busy` renders: one sign-in at a time.
  const pending = useRef(false);
  const leaving = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);

  const edit =
    <A,>(set: (value: A) => void) =>
    (value: A) => {
      set(value);
      edits.current += 1;
      setFailure(null);
    };

  const submit = () => {
    if (pending.current) return;
    pending.current = true;
    const submitted = edits.current;
    const { signal } = leaving.current;
    setBusy(true);
    setFailure(null);
    // A playlist's link goes where a login's server goes, and as the password of an edit.
    const secret = kind === "m3u" ? link : password;
    const named = mode.kind === "add" ? { name } : {};
    const saving = saved
      ? update(saved.id, { name, ...(secret ? { password: secret } : {}) }, signal)
      : kind === "m3u"
        ? add({ server: link, username: "", password: "", ...named }, signal)
        : add({ server, username, password, ...named }, signal);
    saving.then(
      () => {
        pending.current = false;
        if (!signal.aborted) onDone?.();
      },
      (cause: unknown) => {
        pending.current = false;
        if (signal.aborted) return;
        setBusy(false);
        if (edits.current !== submitted) return;
        const error = appError(cause);
        const host = saved?.server ?? (kind === "m3u" ? link : server);
        setFailure((kind === "m3u" && playlistFailure(error)) || failureOf(error, host));
      },
    );
  };

  const prefix = mode.kind === "connect" ? "connect" : "provider";
  const label = LABELS[mode.kind];
  const unchanged = mode.kind === "edit" && !mode.member.needsSecret ? "Unchanged" : undefined;
  return (
    <>
      {saved ? null : (
        <View style={styles.kinds} accessibilityRole="tablist">
          {KINDS.map((each) => (
            <Pressable
              key={each.kind}
              accessibilityRole="tab"
              accessibilityState={{ selected: kind === each.kind }}
              onPress={() => kind !== each.kind && edit(setKind)(each.kind)}
              style={styles.kind}
              testID={`${prefix}-kind-${each.kind}`}
            >
              <Text style={[styles.kindLabel, kind === each.kind && styles.kindSelected]}>
                {each.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {mode.kind === "connect" ? null : (
        <Field label="Name" value={name} onChange={edit(setName)} prefix={prefix} optional />
      )}
      {saved ? (
        <Text style={styles.account} numberOfLines={2}>
          {saved.kind === "m3u" ? "M3U playlist" : `${hostOf(saved.server)} · ${saved.username}`}
        </Text>
      ) : null}
      {kind === "m3u" ? (
        <Field
          label={saved ? "New playlist link" : "Playlist link"}
          value={link}
          onChange={edit(setLink)}
          placeholder={saved ? unchanged : "https://tv.example.com/playlist.m3u"}
          keyboard="url"
          onSubmit={submit}
          prefix={prefix}
        />
      ) : (
        <>
          {saved ? null : (
            <>
              <Field
                label="Server"
                value={server}
                onChange={edit(setServer)}
                placeholder="http://line.example.com:8080"
                keyboard="url"
                prefix={prefix}
              />
              <Field
                label="Username"
                value={username}
                onChange={edit(setUsername)}
                prefix={prefix}
              />
            </>
          )}
          <Field
            label="Password"
            value={password}
            onChange={edit(setPassword)}
            placeholder={unchanged}
            secret
            onSubmit={submit}
            prefix={prefix}
          />
        </>
      )}
      {failure ? (
        <View accessible accessibilityLiveRegion="polite" testID={`${prefix}-error`}>
          <Text style={styles.error}>{failure.headline}</Text>
          {failure.advice ? <Text style={styles.advice}>{failure.advice}</Text> : null}
        </View>
      ) : null}
      <TextButton
        primary={mode.kind === "connect"}
        label={busy ? label.busy : failure ? "Try again" : label.idle}
        onPress={submit}
        disabled={busy}
        testID={`${prefix}-submit`}
      />
      {footnote?.(kind)}
    </>
  );
}

/** A link that answered with something other than a playlist, in the form's words. */
function playlistFailure(error: AppError): Failure | null {
  if (error.kind !== "unreachable" || !error.detail.includes("not with a playlist")) return null;
  return {
    headline: "This link isn't a playlist",
    advice: "Check the link your provider sent, then try again.",
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  keyboard,
  onSubmit,
  optional,
  prefix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  secret?: boolean;
  keyboard?: "url";
  onSubmit?: () => void;
  optional?: boolean;
  prefix: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? (optional ? "Optional" : undefined)}
        placeholderTextColor="#636366"
        secureTextEntry={secret ?? false}
        textContentType={secret ? "password" : keyboard ? "URL" : optional ? "none" : "username"}
        keyboardType={keyboard === "url" ? "url" : "default"}
        autoCapitalize={optional ? "sentences" : "none"}
        autoCorrect={false}
        returnKeyType={onSubmit ? "go" : "next"}
        onSubmitEditing={onSubmit}
        style={styles.input}
        testID={`${prefix}-${label.toLowerCase().replaceAll(" ", "-")}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  kinds: { flexDirection: "row", gap: 24 },
  kind: { minHeight: 44, justifyContent: "center" },
  kindLabel: { color: colors.dim, fontSize: 17 },
  kindSelected: { color: colors.text, fontWeight: "600" },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 15, fontWeight: "600" },
  input: {
    minHeight: 44,
    color: colors.text,
    fontSize: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  account: { color: colors.text, fontSize: 17 },
  error: { color: "#FF453A", fontSize: 15, fontWeight: "600" },
  advice: { color: colors.text, fontSize: 15, marginTop: 2 },
});
