import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import type { Sources } from "../connect/sources.ts";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import {
  Bar,
  Body,
  DISABLED,
  Dialog,
  Frame,
  RED,
  Snackbar,
  StatusLine,
  TextButton,
  useFrame,
  useLargeText,
} from "./chrome.tsx";
import { t } from "./copy.ts";
import { draftOf, keyOf, remove, resolve, same, step, type Draft, type Entry } from "./model.ts";
import { lists } from "./runtime.ts";
import { FAVOURITES } from "./store.ts";
import {
  Badge,
  Channel,
  Empty,
  Lines,
  ListsSheet,
  NameDialog,
  Note,
  providerOf,
  reason,
} from "./ui.tsx";

/**
 * Whether Favourites shows a saved channel as a row. Those whose provider is still loading or
 * failed wait in its footer instead, keeping their place; lists show every entry.
 */
const showsInFavourites = (entry: Entry, state: Sources) => {
  const found = resolve(entry, state).kind;

  return found !== "loading" && found !== "failed";
};

/** Favourites' footer: the channels it doesn't show, counted by provider and reason. */
function footer(entries: readonly Entry[], state: Sources) {
  const groups = new Map<string, { provider: string; why: string; count: number }>();

  for (const entry of entries) {
    const found = resolve(entry, state).kind;

    if (found !== "loading" && found !== "failed") continue;
    const provider = providerOf(entry.sourceId, state) ?? "";
    const key = JSON.stringify([provider, found]);
    const group = groups.get(key);

    if (group) group.count += 1;
    else groups.set(key, { provider, why: reason(found), count: 1 });
  }

  return [...groups.values()].map((group) => t("{count} saved from {provider}: {why}", group));
}

type Failure =
  | { readonly kind: "save" }
  | { readonly kind: "other"; readonly message: string; readonly retry: () => void };

/**
 * Favourites, or one of the viewer's lists, pushed from Live. Edit makes a draft: Move up, Move
 * down and (in a list) the remove button at a row's start change only the draft, and Save writes
 * order and removals together while the list still shows what the draft began from. Otherwise
 * the "{name} changed" dialog says nothing moved; a failed write keeps the draft under a snackbar
 * with Try again. Close and Back discard the draft. Rename and Delete list, under a list's rows in
 * Edit, write at once. Back closes a dialog, then Edit, then the screen. Nothing here plays more
 * than a row's own tap would, and editing never changes what plays.
 */
export function ListScreen({ favourites = false }: { favourites?: boolean }) {
  useLocale();
  const { layout, framed } = useFrame();
  const large = useLargeText();
  const { id: param = "" } = useLocalSearchParams<{ id: string }>();
  const id = favourites ? FAVOURITES : param;
  const state = useStore(lists.state);
  const providers = useStore(sources.state);
  const list = state.kind === "ready" ? state.lists.find((each) => each.id === id) : undefined;
  const name = favourites ? t("Favourites") : (list?.name ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [dialog, setDialog] = useState<"rename" | "delete" | "changed" | null>(null);
  const [held, setHeld] = useState<Entry | null>(null);
  const focused = useIsFocused();
  const editing = draft !== null;

  /** The list as stored now, for actions that run after this render. */
  const stored = () => {
    const now = lists.state.get();

    return now.kind === "ready" ? now.lists.find((each) => each.id === id) : undefined;
  };

  const close = () => {
    setDraft(null);
    setFailed(null);
  };

  useEffect(() => {
    // Back leaves Edit unsaved before it pops the screen; an open dialog takes it first.
    if (!editing || !focused) return;

    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setDraft(null);
      setFailed(null);

      return true;
    });

    return () => back.remove();
  }, [editing, focused]);

  const save = () => {
    if (!draft) return;

    try {
      lists.commit(draft);
      close();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";

      if (code === "stale") {
        setFailed(null);
        setDialog("changed");
      } else if (code === "deleted") close();
      else setFailed({ kind: "save" });
    }
  };

  /** Takes a channel its provider no longer lists out of the list, at once. */
  const removeNow = (entry: Entry) => {
    const attempt = () => {
      const current = stored();

      if (!current) return;
      const start = draftOf(current, sources.state.get());
      const at = start.entries.findIndex((each) => same(each, entry));

      if (at < 0) return;

      try {
        lists.commit(remove(start, at));
        setFailed(null);
      } catch {
        setFailed({ kind: "other", message: t("{name} wasn't changed", { name }), retry: attempt });
      }
    };

    attempt();
  };

  const deleteNow = () => {
    setDialog(null);

    try {
      lists.delete(id);
      close();
      router.back();
    } catch {
      setFailed({ kind: "other", message: t("{name} wasn't changed", { name }), retry: deleteNow });
    }
  };

  /** After a refused save: Edit starts again from the list as it is now. */
  const restart = () => {
    setDialog(null);
    const current = stored();
    setDraft(current ? draftOf(current, sources.state.get()) : null);
  };

  const shown = (entry: Entry) => !favourites || showsInFavourites(entry, providers);
  const notes = favourites && list ? footer(editing ? draft.entries : list.entries, providers) : [];

  const bar = editing ? (
    <Bar
      layout={layout}
      framed={framed}
      height={layout === "rail" ? 72 : undefined}
      rule={layout === "rail"}
      leading={{ icon: "close", label: t("Close"), onPress: close }}
      title={name}
      trailing={<TextButton label={t("Save")} strong onPress={save} />}
    />
  ) : (
    <Bar
      layout={layout}
      framed={framed}
      leading={{ icon: "arrow-back", label: "Back", onPress: () => router.back() }}
      title={name}
      trailing={
        list?.entries.length ? (
          <TextButton
            label={t("Edit")}
            onPress={() => {
              setFailed(null);
              setDraft(draftOf(list, sources.state.get()));
            }}
          />
        ) : null
      }
    />
  );

  const rows = (draft?.entries ?? list?.entries ?? []).filter(shown);

  return (
    <Frame framed={framed} bar={bar}>
      <Body>
        <ScrollView
          style={{
            flex: 1,
            borderTopWidth: editing && layout === "bar" ? 1 : 0,
            borderColor: colors.hairline,
          }}
          contentContainerStyle={{ paddingBottom: failed ? 72 : 0 }}
        >
          {state.kind === "failed" ? (
            <Empty
              title={t("Couldn't read your lists.")}
              action={<TextButton label={t("Try again")} onPress={lists.read} />}
            />
          ) : !list ? (
            <Empty title={t("This list was deleted.")} />
          ) : editing ? (
            rows.map((entry, position) => (
              <EditRow
                key={keyOf(entry)}
                entry={entry}
                position={position}
                count={rows.length}
                large={large}
                listName={favourites ? undefined : name}
                onMove={(offset) => {
                  const index = draft.entries.indexOf(entry);
                  setDraft(step(draft, index, offset, shown));
                }}
                onRemove={() => setDraft(remove(draft, draft.entries.indexOf(entry)))}
              />
            ))
          ) : (
            rows.map((entry) => (
              <Channel
                key={keyOf(entry)}
                entry={entry}
                onLists={setHeld}
                onRemove={removeNow}
                listName={name}
              />
            ))
          )}
          {list && !list.entries.length && !editing ? (
            favourites ? (
              <Empty title={t("No favourites yet.")} body={t("Star a channel in Live.")} />
            ) : (
              <Empty
                title={t("No channels in {name}.", { name })}
                body={t("Hold a channel in Live to add it.")}
              />
            )
          ) : null}
          {notes.map((note) => (
            <Note key={note}>{note}</Note>
          ))}
          {editing && !favourites ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 8,
                paddingTop: 12,
                paddingHorizontal: 4,
                borderTopWidth: 1,
                borderColor: colors.hairline,
              }}
            >
              <TextButton label={t("Rename")} onPress={() => setDialog("rename")} />
              <TextButton
                label={t("Delete list")}
                color={RED}
                onPress={() => setDialog("delete")}
              />
            </View>
          ) : null}
        </ScrollView>
        <StatusLine />
        {failed ? (
          <Snackbar
            message={failed.kind === "save" ? t("Couldn't save {name}", { name }) : failed.message}
            action={t("Try again")}
            onAction={failed.kind === "save" ? save : failed.retry}
          />
        ) : null}
      </Body>
      <ListsSheet entry={held} onClose={() => setHeld(null)} />
      {dialog === "rename" ? (
        <NameDialog
          title={t("Rename list")}
          initial={name}
          confirm={t("Rename")}
          failed={() => t("Couldn't save {name}", { name })}
          onClose={() => setDialog(null)}
          onSave={(next) => lists.rename(id, next)}
        />
      ) : null}
      {dialog === "delete" ? (
        <Dialog
          title={t("Delete {name}?", { name })}
          body={t("Its channels stay in Live.")}
          onClose={() => setDialog(null)}
          actions={
            <>
              <TextButton label={t("Cancel")} onPress={() => setDialog(null)} />
              <TextButton label={t("Delete")} strong color={RED} onPress={deleteNow} />
            </>
          }
        />
      ) : null}
      {dialog === "changed" ? (
        <Dialog
          title={t("{name} changed", { name })}
          body={t(
            "Nothing was moved or removed. It changed while you edited it: edit it as it is now.",
          )}
          onClose={restart}
          actions={<TextButton label={t("OK")} strong onPress={restart} />}
        />
      ) : null}
    </Frame>
  );
}

/**
 * A row in Edit, one TalkBack stop: "{name}, {position} of {count}" with actions Move up, Move
 * down and, in a list, Remove from it, which its visible buttons also do. At 200% text the move
 * buttons drop under the lines with their labels.
 */
function EditRow({
  entry,
  position,
  count,
  large,
  listName,
  onMove,
  onRemove,
}: {
  entry: Entry;
  position: number;
  count: number;
  large: boolean;
  /** Given, the row offers removing it from this list. */
  listName?: string | undefined;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const providers = useStore(sources.state);
  const found = resolve(entry, providers);
  const title = found.kind === "listed" ? found.row.title : entry.title;
  const first = position === 0;
  const last = position === count - 1;
  const where = t("{position} of {count}", { position: position + 1, count });

  const actions = [
    ...(first ? [] : [{ name: "up", label: t("Move up") }]),
    ...(last ? [] : [{ name: "down", label: t("Move down") }]),
    ...(listName ? [{ name: "remove", label: t("Remove from {list}", { list: listName }) }] : []),
  ];

  const removeButton = listName ? (
    <View importantForAccessibility="no-hide-descendants">
      <RemoveButton
        large={large}
        label={t("Remove from {list}", { list: listName })}
        onPress={onRemove}
      />
    </View>
  ) : null;

  const a11y = {
    accessible: true,
    accessibilityLabel: t("{name}, {position} of {count}", {
      name: title,
      position: position + 1,
      count,
    }),
    accessibilityActions: actions,
    onAccessibilityAction: ({ nativeEvent }: { nativeEvent: { actionName: string } }) => {
      if (nativeEvent.actionName === "up") onMove(-1);

      if (nativeEvent.actionName === "down") onMove(1);

      if (nativeEvent.actionName === "remove") onRemove();
    },
  };

  if (large)
    return (
      <View
        {...a11y}
        style={{
          gap: 4,
          paddingTop: 12,
          paddingBottom: 8,
          paddingLeft: listName ? 4 : 16,
          paddingRight: 16,
          borderBottomWidth: 1,
          borderColor: colors.hairline,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          {removeButton}
          <Lines title={title} detail={where} dim={found.kind !== "listed"} gap={2} />
        </View>
        <View
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, paddingLeft: listName ? 52 : 0 }}
        >
          <LabelledMove
            icon="arrow-upward"
            label={t("Move up")}
            disabled={first}
            onPress={() => onMove(-1)}
          />
          <LabelledMove
            icon="arrow-downward"
            label={t("Move down")}
            disabled={last}
            onPress={() => onMove(1)}
          />
        </View>
      </View>
    );

  return (
    <View
      {...a11y}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: listName ? 12 : 16,
        minHeight: 72,
        paddingLeft: listName ? 4 : 16,
        paddingRight: 4,
      }}
    >
      {removeButton}
      <Badge title={title} look={found.kind === "listed" ? "row" : "absent"} />
      <Lines title={title} detail={where} dim={found.kind !== "listed"} gap={2} />
      <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row" }}>
        <MoveButton
          icon="arrow-upward"
          label={t("Move up")}
          disabled={first}
          onPress={() => onMove(-1)}
        />
        <MoveButton
          icon="arrow-downward"
          label={t("Move down")}
          disabled={last}
          onPress={() => onMove(1)}
        />
      </View>
    </View>
  );
}

/** The remove button at an edit row's start: a red minus in a circle, 32dp at 200% text. */
function RemoveButton({
  large,
  label,
  onPress,
}: {
  large: boolean;
  label: string;
  onPress: () => void;
}) {
  if (!large)
    return <IconButton icon="remove-circle-outline" label={label} color={RED} onPress={onPress} />;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
    >
      <MaterialIcons name="remove-circle-outline" size={32} color={RED} />
    </Pressable>
  );
}

/** Move up or Move down as a 48dp icon button, grey and inert at the list's end. */
function MoveButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons name={icon} size={24} color={disabled ? DISABLED : colors.text} />
    </Pressable>
  );
}

/** At 200% text, Move up or Move down with its label under the row's lines; 40% when inert. */
function LabelledMove({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 56,
        paddingHorizontal: 12,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons name={icon} size={32} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}
