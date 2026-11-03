import { useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CUSTOM_LIST_NAME_MAX } from "@mrstreamer/contracts/custom-lists";
import { formatList } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import { useOpenShared } from "../navigation/open.ts";
import { useStore } from "../platform/store.ts";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import { t } from "./copy.ts";
import { discover } from "./discovery.ts";
import { identity, resolve, same, type Entry } from "./model.ts";
import { intentHandlers } from "./intents.ts";
import { lists } from "./runtime.ts";
import { FAVOURITES } from "./store.ts";

export function Label({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.text, fontSize: 16 }}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={{ minHeight: 48, padding: 12, justifyContent: "center", opacity: disabled ? 0.4 : 1 }}
    >
      <Label>{title}</Label>
    </Pressable>
  );
}

export function Content({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 16, gap: 8 }}>
      {children}
    </ScrollView>
  );
}

export function failure(cause: unknown, name: string) {
  const code = cause instanceof Error ? cause.message : "";
  Alert.alert(
    t("{name} wasn't changed", { name }),
    code === "name-taken"
      ? t("There's already a list called {name}.", { name })
      : code === "name-length"
        ? t("A list's name has 1 to {max} characters.", { max: CUSTOM_LIST_NAME_MAX })
        : code.startsWith("identity")
          ? t("Nothing was moved.")
          : t("Couldn't save {name}", { name }),
  );
}

export function Status() {
  useLocale();
  const state = useStore(sources.state);
  const open = useOpenShared();
  const view = discover(state);

  return (
    <View accessibilityLiveRegion="polite">
      {view.restoring ? <Label>{t("Loading channels…")}</Label> : null}
      {view.loading.length ? (
        <>
          <Label>
            {t("Loading channels from {providers}.", { providers: formatList(view.loading) })}
          </Label>
          <Label>{t("Loading channels…")}</Label>
        </>
      ) : null}
      {view.failed.length ? (
        <>
          <Label>
            {t("Couldn't load channels from {providers}.", { providers: formatList(view.failed) })}
          </Label>
          <Button
            title={t("Try again")}
            onPress={() => {
              if (state.kind === "ready")
                state.sources
                  .filter((s) => s.channels.kind === "failed")
                  .forEach((s) => sources.retry(s.id));
            }}
          />
          <Button title={t("Settings")} onPress={() => open("settings")} />
        </>
      ) : null}
    </View>
  );
}

/** One focus stop; only a current, uniquely matched channel with a handler offers Play. */
export function Channel({ entry, onLists }: { entry: Entry; onLists(entry: Entry): void }) {
  useLocale();
  const state = useStore(sources.state);
  const handlers = useStore(intentHandlers);
  const saved = useStore(lists.state);
  const found = resolve(entry, state);

  const starred =
    saved.kind === "ready" &&
    saved.lists.find((list) => list.id === FAVOURITES)?.entries.some((each) => same(each, entry));

  const play = () => {
    const now = resolve(entry, sources.state.get());

    if (now.kind !== "listed") return failure(new Error("identity"), entry.title);
    intentHandlers.get().play?.({ ...identity(now.row), kind: "live" });
  };

  const star = () => {
    try {
      lists.member(FAVOURITES, entry, !starred);
    } catch (cause) {
      failure(cause, entry.title);
    }
  };

  const playable = found.kind === "listed" && !!handlers.play;
  const schedule = found.kind === "listed" && !!handlers.schedule;
  const title = found.kind === "listed" ? found.row.title : entry.title;

  return (
    <View>
      <Pressable
        accessible
        accessibilityRole={playable ? "button" : undefined}
        accessibilityLabel={title}
        accessibilityHint={playable ? t("Play {channel}", { channel: title }) : undefined}
        accessibilityActions={[
          { name: "lists", label: t("Lists") },
          ...(found.kind === "listed"
            ? [{ name: "star", label: t(starred ? "Remove from Favourites" : "Add to Favourites") }]
            : []),
          ...(schedule ? [{ name: "schedule", label: t("Schedule") }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "lists") onLists(entry);

          if (nativeEvent.actionName === "star") star();

          if (nativeEvent.actionName === "schedule") {
            const now = resolve(entry, sources.state.get());

            if (now.kind === "listed")
              intentHandlers.get().schedule?.({ ...identity(now.row), kind: "schedule" });
          }
        }}
        onPress={playable ? play : undefined}
        onLongPress={() => onLists(entry)}
        style={{ minHeight: 56, padding: 12, borderBottomWidth: 1, borderColor: colors.hairline }}
      >
        <Label>{title}</Label>
        {found.kind !== "listed" ? (
          <Label>
            {t(
              found.kind === "loading"
                ? "channels still loading"
                : found.kind === "failed"
                  ? "channels didn't load"
                  : "no longer listed",
            )}
          </Label>
        ) : null}
      </Pressable>
    </View>
  );
}

/** Controlled dialog keeps its text after validation or storage fails. */
export function NameDialog({
  visible,
  initial = "",
  title,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial?: string;
  title: string;
  onClose(): void;
  onSave(name: string): void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");

  return (
    <Modal visible={visible} transparent onRequestClose={onClose}>
      <View
        style={{ flex: 1, justifyContent: "center", backgroundColor: colors.scrim, padding: 24 }}
      >
        <View accessibilityViewIsModal style={{ backgroundColor: colors.surface, padding: 16 }}>
          <Label>{title}</Label>
          <TextInput
            autoFocus
            accessibilityLabel={title}
            value={name}
            onChangeText={setName}
            style={{ color: colors.text, minHeight: 48, fontSize: 18 }}
          />
          <Label>{`${name.length}/${CUSTOM_LIST_NAME_MAX}`}</Label>
          {error ? (
            <Text accessibilityLiveRegion="polite" style={{ color: "#FF5A4E" }}>
              {error}
            </Text>
          ) : null}
          <Button
            title={t("Save")}
            onPress={() => {
              try {
                onSave(name);
                onClose();
              } catch (cause) {
                const code = cause instanceof Error ? cause.message : "";
                setError(
                  code === "name-taken"
                    ? t("There's already a list called {name}.", { name })
                    : code === "name-length"
                      ? t("A list's name has 1 to {max} characters.", { max: CUSTOM_LIST_NAME_MAX })
                      : t("Couldn't save {name}", { name }),
                );
              }
            }}
          />
          <Button title={t("Cancel")} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

export function ListsSheet({ entry, onClose }: { entry: Entry | null; onClose(): void }) {
  const saved = useStore(lists.state);
  const [creating, setCreating] = useState(false);

  return (
    <Sheet visible={entry !== null} label={t("Lists")} onClose={onClose}>
      <Content>
        <Label>{entry?.title}</Label>
        <Label>
          {entry?.sourceId
            ? (() => {
                const now = sources.state.get();

                return now.kind === "ready"
                  ? now.sources.find((s) => s.id === entry.sourceId)?.label
                  : "";
              })()
            : ""}
        </Label>
        {saved.kind === "failed" ? (
          <>
            <Label>{t("Couldn't read your lists.")}</Label>
            <Button title={t("Try again")} onPress={lists.read} />
          </>
        ) : (
          saved.lists.map((list) => {
            const included = entry && list.entries.some((each) => same(each, entry));

            return (
              <Button
                key={list.id}
                title={
                  list.id === FAVOURITES
                    ? t(included ? "Remove from Favourites" : "Add to Favourites")
                    : `${included ? "✓ " : ""}${list.name}`
                }
                onPress={() => {
                  if (!entry) return;

                  try {
                    lists.member(list.id, entry, !included);
                  } catch (cause) {
                    failure(cause, list.name);
                  }
                }}
              />
            );
          })
        )}
        <Button title={t("New list…")} onPress={() => setCreating(true)} />
        <Button title={t("Close")} onPress={onClose} />
      </Content>
      {creating ? (
        <NameDialog
          visible
          title={t("New list")}
          onClose={() => setCreating(false)}
          onSave={(name) => {
            if (entry) lists.create(name, entry);
          }}
        />
      ) : null}
    </Sheet>
  );
}
