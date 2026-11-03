import { t as sharedT } from "@mrstreamer/core/i18n";
import { router, useSegments } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { destinationIn } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { guides, type GuideLink, type GuideRefusal } from "./guide-sources.ts";
import { useGuideStart } from "./hooks.ts";
import { labelOf, refusalText } from "./present.ts";
import { mapHref } from "./routes.ts";
import { guide, useGuideStatus } from "./runtime.ts";
import { statusLines } from "./status.ts";
import { useLocale } from "./catalogue.ts";
import { t } from "./strings.ts";
import {
  ActionSheet,
  ConfirmDialog,
  Field,
  guideColors,
  Icon,
  Press,
  text,
  type Action,
} from "./ui.tsx";

// Settings > Guides: each provider's own guide first, read only with how it stands, then the
// XMLTV guides added apart from them (guide-sources.ts) in the order channels read them, each
// with a ⋮ sheet of what can be done to it, Map channels, and the add form. Nothing here shows a
// saved link: a guide is named by its name or its link's host, and the link field is masked.

/** A guide's row: its icon, name and status lines, and a trailing 48dp slot. */
function GuideRow({
  icon,
  name,
  lines,
  trailing,
}: {
  icon: IconName;
  name: string;
  lines: readonly { readonly text: string; readonly failed?: true }[];
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 72,
        paddingVertical: 12,
        paddingLeft: 16,
        paddingRight: 4,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Icon name={icon} color={colors.secondary} />
      <View accessible style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={text.title}>{name}</Text>
        {lines.map((line) => (
          <Text
            key={line.text}
            style={[text.secondary, line.failed && { color: guideColors.failure }]}
          >
            {line.text}
          </Text>
        ))}
      </View>
      <View style={{ width: 48, minHeight: 48, flexShrink: 0, justifyContent: "center" }}>
        {trailing}
      </View>
    </View>
  );
}

/**
 * Guides: providers' guides, added guides with their sheet and Remove's confirmation, Map
 * channels, then the form, which adds a guide or, after Replace link or Enter link, gives that
 * one its new link.
 */
export function GuidesScreen() {
  useGuideStart();
  useLocale();
  useGuideStatus();
  const state = useStore(sources.state);
  const links = guides.useLinks();
  const mappings = guides.useMappings();
  const destination = destinationIn(useSegments());
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState<GuideLink | null>(null);
  const [removing, setRemoving] = useState<GuideLink | null>(null);
  const [replacing, setReplacing] = useState<GuideLink | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const actions: readonly Action[] = menu
    ? [
        ...(menu.locked
          ? [{ label: sharedT("Enter link"), icon: "edit" as const, run: () => setReplacing(menu) }]
          : [
              {
                label: t("Refresh"),
                icon: "refresh" as const,
                run: () => void guides.refresh(menu.id),
              },
              { label: t("Replace link"), icon: "edit" as const, run: () => setReplacing(menu) },
            ]),
        {
          label: sharedT("Remove"),
          icon: "delete-outline",
          run: () => setRemoving(menu),
          destructive: true,
        },
      ]
    : [];

  const remove = (link: GuideLink) => {
    setReplacing((now) => (now?.id === link.id ? null : now));
    setFailure(null);
    void guides
      .remove(link.id)
      .catch((): GuideRefusal => "saving")
      .then((refused) => {
        if (!refused) return;
        const words = t("Couldn't remove {name}", { name: labelOf(link) });
        setFailure(words);
        AccessibilityInfo.announceForAccessibility(words);
      });
  };

  return (
    <Screen title={sharedT("Guides")} pushed>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        {state.kind === "ready"
          ? state.sources.map((source) => {
              const lines = statusLines(guide.status(source.id));
              const [first, ...rest] = lines;
              const own = t("Its provider's guide");

              return (
                <GuideRow
                  key={source.id}
                  icon="live-tv"
                  name={source.label}
                  // A failure keeps its own line, in red, under the provider's guide.
                  lines={
                    !first || first.failed
                      ? [{ text: own }, ...lines]
                      : [{ text: `${own} · ${first.text}` }, ...rest]
                  }
                />
              );
            })
          : null}
        {links.map((link) => (
          <GuideRow
            key={link.id}
            icon="link"
            name={labelOf(link)}
            lines={statusLines(guide.status(link.id), link.locked)}
            trailing={
              <IconButton
                icon="more-vert"
                label={sharedT("Options for {list}", { list: labelOf(link) })}
                color={colors.secondary}
                onPress={() => setMenu(link)}
              />
            }
          />
        ))}
        {failure ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[
              text.secondary,
              { color: guideColors.failure, paddingHorizontal: 16, paddingVertical: 12 },
            ]}
          >
            {failure}
          </Text>
        ) : null}
        <Press
          accessibilityLabel={
            mappings.size
              ? t("Map channels, {count} mapped", { count: mappings.size })
              : sharedT("Map channels")
          }
          onPress={() => router.push(mapHref(destination))}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            minHeight: 56,
            paddingLeft: 16,
            paddingRight: 4,
            borderBottomWidth: 1,
            borderColor: colors.hairline,
          }}
        >
          <Icon name="swap-horiz" />
          <Text style={[text.title, { flex: 1 }]}>{sharedT("Map channels")}</Text>
          {mappings.size ? (
            <Text style={[text.secondary, { flexShrink: 1 }]}>
              {t("{count} mapped", { count: mappings.size })}
            </Text>
          ) : null}
          <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
            <Icon name="chevron-right" color={colors.secondary} />
          </View>
        </Press>
        <LinkForm
          // A new guide's form starts again empty, as does another guide's.
          key={replacing?.id ?? "add"}
          replacing={replacing}
          onDone={() => setReplacing(null)}
        />
      </ScrollView>
      <ActionSheet
        title={menu ? labelOf(menu) : null}
        actions={actions}
        onClose={() => setMenu(null)}
      />
      <ConfirmDialog
        title={removing ? t("Remove {name}?", { name: labelOf(removing) }) : null}
        body={t(
          "Its programmes go from the guide and its link from this phone. Channels mapped to its ids keep their mapping.",
        )}
        confirm={sharedT("Remove")}
        onConfirm={() => removing && remove(removing)}
        onClose={() => setRemoving(null)}
      />
    </Screen>
  );
}

/**
 * Adds a guide by its link and an optional name, or gives `replacing` a new link, keeping its
 * name. A refusal shows under the fields until one changes; a guide taken clears them.
 */
function LinkForm({ replacing, onDone }: { replacing: GuideLink | null; onDone: () => void }) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<GuideRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  // The keyboard's Go can submit before `busy` renders: one change at a time.
  const pending = useRef(false);
  const ready = !busy && link.trim() !== "";

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setRefusal(null);
  };

  const submit = () => {
    if (pending.current || !link.trim()) return;
    pending.current = true;
    setBusy(true);
    const change = replacing ? guides.replace(replacing.id, link) : guides.add(link, name);
    void change
      .catch((): GuideRefusal => "saving")
      .then((refused) => {
        pending.current = false;
        setBusy(false);
        setRefusal(refused);

        if (refused) {
          AccessibilityInfo.announceForAccessibility(refusalText(refused));

          return;
        }

        setLink("");
        setName("");
        onDone();
      });
  };

  const action = (
    label: string,
    icon: IconName,
    onPress: () => void,
    enabled: boolean,
    primary = false,
  ) => (
    <Press
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 48,
        paddingHorizontal: 16,
      }}
    >
      <Icon name={icon} color={enabled ? colors.text : colors.secondary} />
      <Text
        style={[
          text.heading,
          { flex: 1, color: enabled ? colors.text : colors.secondary },
          !primary && { fontWeight: "500" },
        ]}
      >
        {label}
      </Text>
    </Press>
  );

  return (
    <View style={{ paddingTop: 16 }}>
      <View style={{ minHeight: 40, justifyContent: "center", paddingHorizontal: 16 }}>
        <Text accessibilityRole="header" style={text.heading}>
          {replacing ? t("New link for {name}", { name: labelOf(replacing) }) : t("Add guide")}
        </Text>
      </View>
      <Field
        icon="link"
        label={t("XMLTV link")}
        value={link}
        onChangeText={edit(setLink)}
        // A link can hold a key: masked, and nothing for autofill to offer or keep.
        secureTextEntry
        inputMode="url"
        autoComplete="off"
        importantForAutofill="no"
        returnKeyType="go"
        onSubmitEditing={submit}
        editable={!busy}
        // Replace link and Enter link open the form below the guides: its field takes focus.
        autoFocus={replacing !== null}
      />
      {replacing ? null : (
        <Field
          icon="label-outline"
          label={sharedT("Name")}
          hint={t("Optional")}
          value={name}
          onChangeText={edit(setName)}
          autoCapitalize="sentences"
          returnKeyType="go"
          onSubmitEditing={submit}
          editable={!busy}
        />
      )}
      {refusal ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            text.secondary,
            { color: guideColors.failure, paddingLeft: 56, paddingRight: 16, paddingVertical: 12 },
          ]}
        >
          {refusalText(refusal)}
        </Text>
      ) : null}
      {replacing
        ? action(busy ? t("Saving") : sharedT("Save"), "check", submit, ready, true)
        : action(busy ? t("Adding") : sharedT("Add"), "add", submit, ready, true)}
      {replacing ? action(sharedT("Cancel"), "close", onDone, !busy) : null}
      <Text style={[text.note, { paddingLeft: 56, paddingRight: 16, paddingTop: 8 }]}>
        {t(
          "Channels use their provider's guide first, then these in order. Links stay sealed on this phone.",
        )}
      </Text>
    </View>
  );
}
