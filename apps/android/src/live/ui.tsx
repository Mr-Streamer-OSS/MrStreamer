import { providerRequired } from "../preview/session.ts";
import { router, useSegments } from "expo-router";
import { scheduleHref } from "../guide/routes.ts";
import { destinationIn } from "../navigation/open.ts";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { CUSTOM_LIST_NAME_MAX } from "@mrstreamer/contracts/custom-lists";
import { sources } from "../bootstrap/sources.ts";
import type { Sources } from "../connect/sources.ts";
import { player } from "../player/instance.ts";
import { watchHref } from "../player/intent.ts";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import { Dialog, FitSheet, RAISED_RULE, RED, SheetRow, TextButton, useGaps } from "./chrome.tsx";
import { t } from "./copy.ts";
import { playIntent, resolve, same, type Entry, type Resolution } from "./model.ts";
import { lists } from "./runtime.ts";
import { FAVOURITES } from "./store.ts";

/** Says why adding a channel to a list, or taking it out, was refused, in a platform alert. */
function failure(cause: unknown, name: string) {
  const code = cause instanceof Error ? cause.message : "";
  Alert.alert(
    t("{name} wasn't changed", { name }),
    code.startsWith("identity") ? t("Nothing was moved.") : t("Couldn't save {name}", { name }),
  );
}

/** The provider's name for a saved channel's source, while one source has that id. */
export function providerOf(sourceId: string, state: Sources): string | undefined {
  if (state.kind !== "ready") return undefined;
  const owners = state.sources.filter((source) => source.id === sourceId);

  return owners.length === 1 ? owners[0]!.label : undefined;
}

/** Why a saved channel doesn't show, after its provider's name: "Kade TV: channels didn't load". */
function whyNot(resolution: Exclude<Resolution["kind"], "listed">, provider?: string) {
  if (resolution === "removed" || !provider) return t("Its provider was removed.");

  if (resolution === "ambiguous")
    return t("Its provider lists the channel as more than one channel now.");

  return t("{provider}: {why}", { provider, why: reason(resolution) });
}

/** The short reason after a provider's name, as Favourites' footer says it. */
export const reason = (resolution: "loading" | "failed" | "missing") =>
  t(
    resolution === "loading"
      ? "channels still loading"
      : resolution === "failed"
        ? "channels didn't load"
        : "no longer listed",
  );

/** Up to two initials for a channel's badge: "Harbour HD" is "HH", a one-word "Nova" is "NO". */
function monogram(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first, second] = words.map((word) => Array.from(word));
  const letters = second ? [first?.[0], second[0]] : (first ?? []).slice(0, 2);

  return letters.join("").toLocaleUpperCase();
}

/**
 * A channel's 48x36dp badge: its initials on #141414, on #262626 inside a sheet, or outlined and
 * dimmed for a saved channel that doesn't show.
 */
export function Badge({
  title,
  look = "row",
}: {
  title: string;
  look?: "row" | "sheet" | "absent";
}) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 48,
        height: 36,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        borderWidth: look === "absent" ? 1 : 0,
        borderColor: RAISED_RULE,
        backgroundColor:
          look === "row" ? colors.surface : look === "sheet" ? RAISED_RULE : undefined,
      }}
    >
      <Text
        style={{
          color: look === "absent" ? colors.inactive : colors.text,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: "700",
        }}
      >
        {monogram(title)}
      </Text>
    </View>
  );
}

/** A row's two lines: the 16sp name over its 14sp grey detail. */
export function Lines({
  title,
  detail,
  dim = false,
  gap = 4,
}: {
  title: string;
  detail?: string | undefined;
  dim?: boolean;
  gap?: number;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0, gap, paddingVertical: 12 }}>
      <Text
        numberOfLines={2}
        style={{
          color: dim ? colors.secondary : colors.text,
          fontSize: 16,
          lineHeight: 20,
          fontWeight: "500",
        }}
      >
        {title}
      </Text>
      {detail ? (
        <Text numberOfLines={2} style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A channel's 72dp row, one TalkBack stop: its name and what's on, with actions Add to or Remove
 * from Favourites and Lists. Holding it opens the Lists sheet; the star stars it and plays
 * nothing. A current, uniquely matched channel plays and opens Watch on activation. A saved channel that
 * doesn't show says why, plays nothing, and offers Remove (when `onRemove` is given) only once
 * its provider no longer lists it.
 */
export function Channel({
  entry,
  onLists,
  onRemove,
  listName,
}: {
  entry: Entry;
  onLists: (entry: Entry) => void;
  onRemove?: ((entry: Entry) => void) | undefined;
  /** The list `onRemove` takes it out of, for TalkBack's action. */
  listName?: string;
}) {
  useLocale();
  const destination = destinationIn(useSegments());
  const schedule = () => router.push(scheduleHref(destination, entry));
  const state = useStore(sources.state);
  const saved = useStore(lists.state);
  const found = resolve(entry, state);
  const { focused, handlers: focus } = useKeyboardFocus();

  const starred =
    saved.kind === "ready" &&
    !!saved.lists.find((list) => list.id === FAVOURITES)?.entries.some((each) => same(each, entry));

  if (found.kind !== "listed") {
    const removable = onRemove && (found.kind === "missing" || found.kind === "removed");
    const detail = whyNot(found.kind, providerOf(entry.sourceId, state));

    return (
      <View
        accessible
        accessibilityLabel={`${entry.title}, ${detail}`}
        accessibilityActions={
          removable
            ? [{ name: "remove", label: t("Remove from {list}", { list: listName ?? "" }) }]
            : []
        }
        onAccessibilityAction={() => onRemove?.(entry)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 16,
          minHeight: 72,
          paddingLeft: 16,
          paddingRight: removable ? 4 : 16,
        }}
      >
        <Badge title={entry.title} look="absent" />
        <Lines title={entry.title} detail={detail} dim gap={2} />
        {removable ? <TextButton label={t("Remove")} onPress={() => onRemove(entry)} /> : null}
      </View>
    );
  }

  const title = found.row.title;
  const now = t("No programme information");
  const favourite = t(starred ? "Remove from Favourites" : "Add to Favourites");

  const openLists = () => {
    if (!providerRequired("save", entry.sourceId)) onLists(entry);
  };

  const play = () => {
    if (providerRequired("play", entry.sourceId)) return;
    const intent = playIntent(entry, sources.state.get());

    if (!intent) return;
    player.play(intent);
    router.push(watchHref(intent));
  };

  const star = () => {
    try {
      const current = resolve(entry, sources.state.get());

      if (current.kind !== "listed") return;
      lists.member(FAVOURITES, { ...entry, title: current.row.title }, !starred);
    } catch (cause) {
      failure(cause, entry.title);
    }
  };

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${now}`}
      // Android's click label: TalkBack says "Double-tap to play" for a playable row.
      accessibilityActions={[
        { name: "activate", label: t("Play") },
        { name: "schedule", label: t("Schedule") },
        ...(saved.kind === "ready" ? [{ name: "star", label: favourite }] : []),
        { name: "lists", label: t("Lists") },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate") play();

        if (nativeEvent.actionName === "star" && saved.kind === "ready") star();

        if (nativeEvent.actionName === "lists") openLists();

        if (nativeEvent.actionName === "schedule") schedule();
      }}
      onPress={play}
      onLongPress={openLists}
      {...focus}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 72,
        paddingLeft: 16,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Badge title={title} />
      <Lines title={title} detail={now} />
      {saved.kind === "ready" ? (
        <View importantForAccessibility="no-hide-descendants">
          <IconButton
            icon={starred ? "star" : "star-border"}
            label={favourite}
            color={starred ? colors.text : colors.secondary}
            onPress={star}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Still placeholder rows for channels a provider hasn't sent yet, in the channel rows' lanes. They
 * don't shimmer or pulse: the status line says what's loading.
 */
export function StillRows({ count = 5 }: { count?: number }) {
  return (
    <View importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            height: 72,
            paddingLeft: 16,
          }}
        >
          <View
            style={{ width: 48, height: 36, borderRadius: 4, backgroundColor: colors.surface }}
          />
          <View style={{ flex: 1, gap: 8 }}>
            <View
              style={{ width: 120, height: 12, borderRadius: 2, backgroundColor: colors.hairline }}
            />
            <View
              style={{ width: 176, height: 10, borderRadius: 2, backgroundColor: colors.surface }}
            />
          </View>
          <View style={{ width: 48, height: 48 }} />
        </View>
      ))}
    </View>
  );
}

/**
 * A row that opens a screen: Live's 48dp shortcuts (Favourites, each list, Find) with a chevron,
 * or a 56dp country or category from Find and Categories, its channel count at the end.
 */
export function NavRow({
  icon,
  label,
  count,
  accessibilityLabel,
  onPress,
  size = "result",
}: {
  icon: IconName;
  label: string;
  count?: string | undefined;
  accessibilityLabel?: string;
  onPress: () => void;
  size?: "shortcut" | "result";
}) {
  const { focused, handlers } = useKeyboardFocus();
  const shortcut = size === "shortcut";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (count ? `${label}, ${count}` : label)}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: shortcut ? 48 : 56,
        paddingLeft: 16,
        paddingRight: shortcut ? 8 : 16,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons name={icon} size={24} color={colors.text} />
      <Text
        style={{
          flex: 1,
          minWidth: 0,
          paddingVertical: 8,
          color: colors.text,
          fontSize: 16,
          lineHeight: 20,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      {count ? (
        <Text style={{ flexShrink: 0, color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
          {count}
        </Text>
      ) : null}
      {shortcut ? <MaterialIcons name="chevron-right" size={24} color={colors.secondary} /> : null}
    </Pressable>
  );
}

/** Grey text in the rows' text lane, as Favourites' "2 saved from Kade TV: channels didn't load". */
export function Note({ children }: { children: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingVertical: 8,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ width: 48, flexShrink: 0 }} />
      <Text style={{ flex: 1, color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
        {children}
      </Text>
    </View>
  );
}

/** A provider gap inline with Find's results: an icon, then the status line's own sentence. */
export function GapRows() {
  const { loading, failed } = useGaps();

  return (
    <>
      {[
        failed ? { icon: "error-outline" as const, color: RED, text: failed } : undefined,
        loading ? { icon: "sync" as const, color: colors.secondary, text: loading } : undefined,
      ].map((gap) =>
        gap ? (
          <View
            key={gap.icon}
            accessible
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              minHeight: 56,
              paddingVertical: 8,
              paddingHorizontal: 16,
            }}
          >
            <MaterialIcons name={gap.icon} size={24} color={gap.color} />
            <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 18 }}>
              {gap.text}
            </Text>
          </View>
        ) : null,
      )}
    </>
  );
}

/** What an empty screen says: a line, the next step under it, and an optional action. */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <View accessible style={{ gap: 4, paddingHorizontal: 16, paddingVertical: 24 }}>
      <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}>
        {title}
      </Text>
      {body ? (
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{body}</Text>
      ) : null}
      {action ? <View style={{ alignItems: "flex-start", marginLeft: -12 }}>{action}</View> : null}
    </View>
  );
}

/**
 * New list and Rename's Material dialog: a 56dp outlined field with the name, a 60-character
 * counter and the reason a name was refused, in red, keeping the text to fix. `onSave` returns
 * false for provider admission refusal, keeping the dialog open, and throws
 * what the lists owner refused.
 */
export function NameDialog({
  title,
  body,
  initial = "",
  confirm,
  failed,
  onClose,
  onSave,
}: {
  title: string;
  body?: string | undefined;
  initial?: string;
  confirm: string;
  /** What a storage failure says, for the name typed. */
  failed: (name: string) => string;
  onClose: () => void;
  onSave: (name: string) => void | boolean;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");

  const save = () => {
    try {
      if (onSave(name) !== false) onClose();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      const typed = name.trim();
      setError(
        code === "name-taken"
          ? t("There's already a list called {name}.", { name: typed })
          : code === "name-length"
            ? t("A list's name has 1 to {max} characters.", { max: CUSTOM_LIST_NAME_MAX })
            : failed(typed),
      );
    }
  };

  return (
    <Dialog
      title={title}
      body={body}
      onClose={onClose}
      actions={
        <>
          <TextButton label={t("Cancel")} onPress={onClose} />
          <TextButton label={confirm} strong onPress={save} />
        </>
      }
    >
      <View style={{ gap: 4, paddingTop: 20 }}>
        <TextInput
          autoFocus
          accessibilityLabel={title}
          value={name}
          maxLength={CUSTOM_LIST_NAME_MAX}
          onChangeText={(next) => {
            setName(next);
            setError("");
          }}
          onSubmitEditing={save}
          returnKeyType="done"
          cursorColor={colors.text}
          selectionColor={colors.focus}
          style={{
            minHeight: 56,
            paddingHorizontal: 14,
            borderWidth: 2,
            borderRadius: 4,
            borderColor: error ? RED : colors.text,
            color: colors.text,
            fontSize: 16,
            lineHeight: 20,
          }}
        />
        <View
          style={{
            flexDirection: "row",
            gap: 16,
            justifyContent: "space-between",
            paddingHorizontal: 16,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, color: RED, fontSize: 12, lineHeight: 16 }}
          >
            {error}
          </Text>
          <Text style={{ flexShrink: 0, color: colors.secondary, fontSize: 12, lineHeight: 16 }}>
            {`${name.length}/${CUSTOM_LIST_NAME_MAX}`}
          </Text>
        </View>
      </View>
    </Dialog>
  );
}

/**
 * The one Lists sheet a held row, or TalkBack's Lists action, opens: the channel and its provider,
 * Add to or Remove from Favourites, every list (a check holds the channel; tapping takes it out)
 * and New list…, whose dialog puts the channel in the list it makes.
 */
export function ListsSheet({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const destination = destinationIn(useSegments());
  useLocale();
  const saved = useStore(lists.state);
  const state = useStore(sources.state);
  const [creating, setCreating] = useState(false);
  const shown = entry ?? { sourceId: "", channelId: "", title: "" };
  const provider = providerOf(shown.sourceId, state);

  const toggle = (id: string, name: string, included: boolean) => {
    if (!entry) return;

    try {
      lists.member(id, entry, !included);
    } catch (cause) {
      failure(cause, name);
    }
  };

  const favourites = saved.lists.find((list) => list.id === FAVOURITES);
  const starred = !!favourites?.entries.some((each) => same(each, shown));

  return (
    <FitSheet visible={entry !== null} label={t("Lists")} onClose={onClose}>
      <View
        accessible
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 16,
          paddingHorizontal: 24,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderColor: RAISED_RULE,
        }}
      >
        <Badge title={shown.title} look="sheet" />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}>
            {shown.title}
          </Text>
          {provider ? (
            <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
              {provider}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ paddingTop: 8 }}>
        <SheetRow
          icon="event-note"
          label={t("Schedule")}
          onPress={() => {
            if (entry) {
              onClose();
              router.push(scheduleHref(destination, entry));
            }
          }}
        />
        {saved.kind === "failed" ? (
          <>
            <Text
              style={{
                paddingHorizontal: 24,
                paddingVertical: 8,
                color: colors.text,
                fontSize: 14,
                lineHeight: 18,
              }}
            >
              {t("Couldn't read your lists.")}
            </Text>
            <SheetRow icon="refresh" label={t("Try again")} onPress={lists.read} />
          </>
        ) : (
          <>
            <SheetRow
              icon={starred ? "star" : "star-border"}
              label={t(starred ? "Remove from Favourites" : "Add to Favourites")}
              onPress={() => toggle(FAVOURITES, t("Favourites"), starred)}
            />
            {saved.lists
              .filter((list) => list.id !== FAVOURITES)
              .map((list) => {
                const included = list.entries.some((each) => same(each, shown));

                return (
                  <SheetRow
                    key={list.id}
                    role="checkbox"
                    icon={included ? "check" : undefined}
                    label={list.name}
                    selected={included}
                    trailing={String(list.entries.length)}
                    onPress={() => toggle(list.id, list.name, included)}
                  />
                );
              })}
            <SheetRow icon="add" label={t("New list…")} onPress={() => setCreating(true)} />
          </>
        )}
      </View>
      {creating && entry ? (
        <NameDialog
          title={t("New list")}
          body={t("{name} goes in it.", { name: entry.title })}
          confirm={t("Create")}
          failed={(name) => t("Couldn't make {name}", { name })}
          onClose={() => setCreating(false)}
          onSave={(name) => {
            return Boolean(lists.create(name, entry));
          }}
        />
      ) : null}
    </FitSheet>
  );
}
