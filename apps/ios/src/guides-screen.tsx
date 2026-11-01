import type { Listing } from "@mrstreamer/contracts/guide";
import { formatDate } from "@mrstreamer/core/i18n";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
} from "react-native";
import { retryChannels, useCatalogue, useRoster } from "./account.ts";
import { hostOf } from "./errors.ts";
import type { GuideProblem } from "./guide-native.ts";
import {
  GUIDE_LIMIT,
  MAPPING_MAX,
  guides,
  type GuideLink,
  type GuideRefusal,
} from "./guide-sources.ts";
import { guide, type GuideStatus } from "./guide.ts";
import { tabHref, useTabs, type Tab } from "./header.tsx";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/pages.ts";
import type { Library } from "./library.ts";
import { colors, largeText, Notice, TextButton } from "./ui.tsx";

// Settings > Guides: the XMLTV guides added apart from every provider's own (guide-sources.ts),
// each with how its download stands, an add form, and Map channels, which reads a channel's
// programmes by a guide id of the viewer's choosing. Nothing here shows a saved link: a guide is
// named by its name or its link's host, and the link field is masked. Words follow the interface
// language (i18n/pages.ts); guide, channel and provider names and guide ids stay as they are.

/** Where a Guides screen opens on `tab`, as the playlist's groups do: Home's at the root. */
export const guidesHref = (tab: Tab, screen: "guides" | "guide-map") =>
  tab === "(home)" ? `/${screen}` : `/${tab}/${screen}`;

/** What a guide's row and sheet call it. */
const labelOf = (link: GuideLink) => link.name ?? hostOf(link.origin);

const when = (at: number) => `${formatDate(at, "day")} ${formatDate(at, "time")}`;

/** Each download failure in plain words, as its catalogue key. */
const PROBLEMS = {
  login: "The guide's server refused the link",
  http: "The guide's server answered with an error",
  network: "The guide's server didn't answer",
  redirect: "The link went somewhere this iPhone won't follow",
  xml: "That link isn't an XMLTV guide",
  gzip: "The compressed guide couldn't be opened",
  empty: "The guide has no programmes",
  ended: "The guide's programmes have all ended",
  body: "The guide is too large",
  element: "The guide has an entry too large to read",
  depth: "The guide's file is nested too deeply",
  rows: "The guide has too many programmes or channels",
  time: "The download took too long",
  disk: "There isn't enough space on this iPhone",
  reply: "The guide couldn't be read",
  unavailable: "The guide couldn't be read on this iPhone",
  busy: "The guide was busy. Try again.",
} as const satisfies Record<GuideProblem, Parameters<typeof t>[0]>;

/** Why an add, a new link or a mapping wasn't taken. */
const refusalText = (refusal: GuideRefusal): string => {
  switch (refusal) {
    case "address":
      return t("That isn't a web link");
    case "duplicate":
      return t("That guide is added already");
    case "name":
      return t("A name can't be a link");
    case "limit":
      return t("{count} guides is the most this iPhone reads", { count: GUIDE_LIMIT });
    case "long":
      return t("A guide id is at most {count} bytes", { count: MAPPING_MAX });
    case "saving":
      return t("Couldn't save. Nothing changed.");
  }
};

/** A guide's status as lines under its name, a failure first and marked so. */
function standing(
  link: GuideLink,
  status: GuideStatus,
): readonly { readonly text: string; readonly failed?: true }[] {
  const kept =
    status.availability === "available" && status.fetchedAt !== null
      ? [{ text: t("Showing the guide from {time}", { time: when(status.fetchedAt) }) }]
      : [];
  if (link.locked) return [{ text: t("Enter the link again"), failed: true }, ...kept];
  if (status.activity === "loading") return [{ text: t("Downloading") }];
  if (status.error) return [{ text: t(PROBLEMS[status.error]), failed: true }, ...kept];
  if (status.fetchedAt !== null) {
    return [{ text: t("Updated {time}", { time: when(status.fetchedAt) }) }];
  }
  return [{ text: t("Not downloaded yet") }];
}

/**
 * The external guides, each a row with its status that offers Refresh, Replace link and Remove,
 * or Enter link and Remove when the Keychain didn't give its link back. Map channels, then the
 * form, which adds a guide or, after Replace link or Enter link, gives that one its new link.
 */
export function GuidesScreen() {
  useLocale();
  const links = guides.useLinks();
  const mappings = guides.useMappings();
  useSyncExternalStore(guide.subscribe, guide.getSnapshot);
  const tab = useTabs()?.tab ?? "(home)";
  const [replacing, setReplacing] = useState<GuideLink | null>(null);
  const open = (link: GuideLink) => {
    const label = labelOf(link);
    const actions = [
      ...(link.locked
        ? [{ label: t("Enter link"), run: () => setReplacing(link) }]
        : [
            { label: t("Refresh"), run: () => void guides.refresh(link.id) },
            { label: t("Replace link"), run: () => setReplacing(link) },
          ]),
      { label: t("Remove"), run: () => confirmRemove(link) },
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: label,
        options: [...actions.map((action) => action.label), t("Cancel")],
        destructiveButtonIndex: actions.length - 1,
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.run(),
    );
  };
  const confirmRemove = (link: GuideLink) =>
    Alert.alert(
      t("Remove {name}?", { name: labelOf(link) }),
      t(
        "Its programmes go from the guide and its link from this iPhone. Channels mapped to its ids keep their mapping.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Remove"),
          style: "destructive",
          onPress: () => {
            setReplacing((now) => (now?.id === link.id ? null : now));
            void guides.remove(link.id).then((refused) => {
              if (refused) {
                Alert.alert(t("Couldn't remove {name}", { name: labelOf(link) }), t("Try again."));
              }
            });
          },
        },
      ],
    );
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {links.map((link) => {
        const lines = standing(link, guide.status(link.id));
        const label = labelOf(link);
        return (
          <Pressable
            key={link.id}
            accessibilityRole="button"
            accessibilityLabel={[label, ...lines.map((line) => line.text)].join(", ")}
            onPress={() => open(link)}
            style={({ pressed }) => [styles.guide, pressed && styles.pressed]}
            testID={`guides-${link.id}`}
          >
            <Text style={styles.name}>{label}</Text>
            {lines.map((line) => (
              <Text key={line.text} style={[styles.plain, line.failed && styles.failed]}>
                {line.text}
              </Text>
            ))}
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          mappings.size
            ? t("Map channels, {count} mapped", { count: mappings.size })
            : t("Map channels")
        }
        onPress={() => router.push(guidesHref(tab, "guide-map"))}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        testID="guides-map"
      >
        <Text style={styles.label}>{t("Map channels")}</Text>
        <View style={styles.opens}>
          {mappings.size ? (
            <Text style={styles.value}>{t("{count} mapped", { count: mappings.size })}</Text>
          ) : null}
          <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
        </View>
      </Pressable>
      <LinkForm
        // A new guide's form starts again empty, as does another guide's.
        key={replacing?.id ?? "add"}
        replacing={replacing}
        onDone={() => setReplacing(null)}
      />
      <Text style={styles.note}>
        {t(
          "Channels use their provider's guide first, then these in order. Links stay in this iPhone's Keychain.",
        )}
      </Text>
    </ScrollView>
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
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setRefusal(null);
  };
  const submit = () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const change = replacing ? guides.replace(replacing.id, link) : guides.add(link, name);
    void change
      .catch((): GuideRefusal => "saving")
      .then((refused) => {
        pending.current = false;
        setBusy(false);
        setRefusal(refused);
        if (refused) return;
        setLink("");
        setName("");
        onDone();
      });
  };
  return (
    <View style={styles.form}>
      <Text style={styles.section} accessibilityRole="header">
        {replacing ? t("New link for {name}", { name: labelOf(replacing) }) : t("Add guide")}
      </Text>
      <Field
        label={t("XMLTV link")}
        value={link}
        onChangeText={edit(setLink)}
        placeholder="https://epg.example.com/guide.xml.gz"
        // A link can hold a key: masked, and no password for AutoFill to offer or keep.
        secureTextEntry
        textContentType="URL"
        keyboardType="url"
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={submit}
        // Replace link and Enter link open the form below the guides: its field takes focus.
        autoFocus={replacing !== null}
        testID="guides-xmltv-link"
      />
      {replacing ? null : (
        <Field
          label={t("Name")}
          value={name}
          onChangeText={edit(setName)}
          placeholder={t("Optional")}
          textContentType="none"
          returnKeyType="go"
          onSubmitEditing={submit}
          testID="guides-name"
        />
      )}
      {refusal ? (
        <View accessible accessibilityLiveRegion="polite" testID="guides-refusal">
          <Text style={styles.refusal}>{refusalText(refusal)}</Text>
        </View>
      ) : null}
      <View style={styles.buttons}>
        <TextButton
          label={t(replacing ? (busy ? "Saving" : "Save") : busy ? "Adding" : "Add")}
          onPress={submit}
          disabled={busy || !link.trim()}
          testID="guides-submit"
        />
        {replacing ? (
          <TextButton label={t("Cancel")} onPress={onDone} disabled={busy} testID="guides-cancel" />
        ) : null}
      </View>
    </View>
  );
}

/** A labelled text field, as the add form and a channel's mapping use it. */
function Field({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#636366"
        autoCorrect={false}
        keyboardAppearance="dark"
        style={styles.input}
        {...input}
      />
    </View>
  );
}

/** A channel Map channels lists: one of the catalogue's, or a mapped one no longer listed. */
interface Mappable {
  readonly key: string;
  readonly title: string;
  readonly line: string | null;
  readonly mapped: string | null;
}

/** How Map channels names channel `key`, from the catalogue when it lists it. */
function describe(key: string, library: Library | null): Omit<Mappable, "mapped"> {
  const listed = library?.byKey.get(key);
  if (listed) return { key, title: listed.title, line: library?.placeOf.get(key) ?? null };
  const at = key.indexOf(":");
  const provider = library?.labels.get(key.slice(0, at));
  return {
    key,
    title: t("Channel {id}", { id: key.slice(at + 1) }),
    // Until the channels are read, nothing says it isn't listed.
    line: library ? [provider, t("No longer listed")].filter(Boolean).join(" · ") : null,
  };
}

/**
 * Map channels: the mapped channels first, those no longer listed too, then every other channel
 * the catalogue lists, found by name or guide id. A row opens its channel's mapping.
 */
export function GuideMapScreen() {
  const locale = useLocale();
  const catalogue = useCatalogue();
  const roster = useRoster();
  const providers =
    roster.kind === "ready"
      ? roster.members
      : catalogue.kind === "failed"
        ? [catalogue.member]
        : [];
  const mappings = guides.useMappings();
  const tab = useTabs()?.tab ?? "(home)";
  const large = largeText(useWindowDimensions().fontScale);
  const [query, setQuery] = useState("");
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const words = query.trim().toLocaleLowerCase();
  const found = ({ title, mapped }: Mappable) =>
    !words ||
    title.toLocaleLowerCase().includes(words) ||
    !!mapped?.toLocaleLowerCase().includes(words);
  const mapped = [...mappings]
    .map(([key, id]) => ({ ...describe(key, library), mapped: id }))
    .filter(found);
  const others = (library?.channels ?? [])
    .filter((channel) => !mappings.has(channel.key))
    .map((channel) => ({ ...describe(channel.key, library), mapped: null }))
    .filter(found);
  const sections = [
    { title: t("Mapped"), data: mapped },
    { title: t("Channels"), data: others },
  ].filter((section) => section.data.length);
  return (
    <SectionList
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      sections={sections}
      keyExtractor={(row) => row.key}
      // Rows draw again in a new language.
      extraData={locale}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <>
          {catalogue.kind === "failed" ? (
            <Notice
              failure={{ headline: t("Couldn't load channels"), advice: null }}
              actions={[
                ...providers
                  .filter((member) => member.needsSecret)
                  .map((member) => ({
                    label:
                      member.entry.kind === "m3u"
                        ? t("Enter playlist link for {provider}", { provider: member.label })
                        : t("Enter password for {provider}", { provider: member.label }),
                    onPress: () =>
                      router.push({
                        pathname: tabHref(tab, "provider"),
                        params: { id: member.entry.id },
                      }),
                  })),
                ...(providers.some((member) => !member.needsSecret && member.live.kind === "failed")
                  ? [{ label: t("Try again"), onPress: retryChannels }]
                  : []),
              ]}
            />
          ) : null}
          <View style={styles.search}>
            <SymbolView name="magnifyingglass" size={15} tintColor={colors.dim} />
            <TextInput
              accessibilityLabel={t("Search channels")}
              value={query}
              onChangeText={setQuery}
              placeholder={t("Search {count} channels", { count: library?.channels.length ?? 0 })}
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              keyboardAppearance="dark"
              selectionColor="#FFFFFF"
              style={styles.searchInput}
              testID="guide-map-search"
            />
          </View>
        </>
      }
      ListEmptyComponent={
        catalogue.kind === "failed" ? undefined : (
          <Text style={styles.none}>
            {t(words ? "No channel by that name" : library ? "No channels" : "Loading channels")}
          </Text>
        )
      }
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[item.title, item.line, item.mapped ?? t("Automatic")]
            .filter(Boolean)
            .join(", ")}
          onPress={() =>
            router.push({ pathname: guidesHref(tab, "guide-map"), params: { channel: item.key } })
          }
          style={({ pressed }) => [
            styles.channel,
            large && styles.stacked,
            pressed && styles.pressed,
          ]}
          testID={`guide-map-${item.key}`}
        >
          <View style={styles.names}>
            <Text style={styles.label}>{item.title}</Text>
            {item.line ? <Text style={styles.small}>{item.line}</Text> : null}
          </View>
          <View style={styles.opens}>
            <Text style={item.mapped ? styles.mapped : styles.value}>
              {item.mapped ?? t("Automatic")}
            </Text>
            <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
          </View>
        </Pressable>
      )}
      ListFooterComponent={<View style={styles.end} />}
    />
  );
}

/** Which guide answered guide id `id` for a channel, and its now and next; null for none. */
interface Preview {
  readonly id: string;
  readonly read: { readonly guide: string; readonly listing: Listing } | null;
}

/**
 * Channel `channelKey`'s mapping: its own guide ids, a guide id field with which guide answers
 * for it and what is on now and next, Save, and Clear back to Automatic once it is mapped. Both
 * go back to the list.
 */
export function GuideMapEditor({ channelKey }: { channelKey: string }) {
  useLocale();
  const catalogue = useCatalogue();
  const links = guides.useLinks();
  const saved = guides.useMappings().get(channelKey) ?? null;
  // Guides and mappings changing withdraw what a preview read: it reads again.
  const snapshot = useSyncExternalStore(guide.subscribe, guide.getSnapshot);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const channel = describe(channelKey, library);
  const own = guide.guideIdsOf(channelKey);
  const [id, setId] = useState(saved ?? "");
  const [answered, setAnswered] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<GuideRefusal | null>(null);
  const wanted = id.trim();
  // The last answer stays while the same id is read again, and shows only for that id.
  const preview = answered?.id === wanted ? answered : null;
  const read = preview?.read ?? null;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    guide
      .preview(channelKey, wanted, { signal: controller.signal })
      .catch(() => null)
      .then((read) => {
        if (!controller.signal.aborted) setAnswered({ id: wanted, read });
      });
    return () => controller.abort();
  }, [channelKey, wanted, snapshot]);
  // Done and Save can both land before the first change answers: it alone goes back.
  const pending = useRef(false);
  const change = (guideId: string | null) => {
    if (pending.current) return;
    pending.current = true;
    void guides
      .map(channelKey, guideId)
      .catch((): GuideRefusal => "saving")
      .then((refused) => {
        pending.current = false;
        if (refused) setRefusal(refused);
        else router.back();
      });
  };
  const source = (owner: string) => {
    const link = links.find((each) => each.id === owner);
    const name = link ? labelOf(link) : library?.labels.get(owner);
    return name ? t("From {guide}", { guide: name }) : t("From its provider's guide");
  };
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">
          {channel.title}
        </Text>
        {channel.line ? <Text style={styles.subtitle}>{channel.line}</Text> : null}
      </View>
      <View style={styles.own} accessible testID="guide-map-own">
        <Text style={styles.fieldLabel}>{t("Its guide ids")}</Text>
        <Text style={styles.text}>{own.length ? own.join(", ") : t("None")}</Text>
      </View>
      <View style={styles.form}>
        <Field
          label={t("Guide id")}
          value={id}
          onChangeText={(value) => {
            setId(value);
            setRefusal(null);
          }}
          placeholder={own[0] ?? t("Automatic")}
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={() => change(id)}
          testID="guide-map-id"
        />
        {preview ? (
          <View accessible accessibilityLiveRegion="polite" testID="guide-map-preview">
            {read ? (
              <>
                <Text style={styles.fieldLabel}>{source(read.guide)}</Text>
                {(["now", "next"] as const).map((at) => {
                  const programme = read.listing[at];
                  return programme ? (
                    <Text key={at} style={styles.text}>
                      <Text style={styles.dim}>{t(at === "now" ? "Now" : "Next")}</Text>
                      {`  ${formatDate(programme.start, "time")}  ${programme.title}`}
                    </Text>
                  ) : null;
                })}
                {read.listing.now || read.listing.next ? null : (
                  <Text style={styles.text}>{t("Nothing now or next")}</Text>
                )}
              </>
            ) : (
              <Text style={styles.text}>{t("No guide has programmes for this id now")}</Text>
            )}
          </View>
        ) : null}
        {refusal ? (
          <View accessible accessibilityLiveRegion="polite" testID="guide-map-refusal">
            <Text style={styles.refusal}>{refusalText(refusal)}</Text>
          </View>
        ) : null}
        <View style={styles.buttons}>
          <TextButton label={t("Save")} onPress={() => change(id)} testID="guide-map-save" />
          {saved ? (
            <TextButton label={t("Clear")} onPress={() => change(null)} testID="guide-map-clear" />
          ) : null}
        </View>
        <Text style={styles.note}>
          {t("Clear goes back to Automatic: its own ids, in its provider's guide first.")}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  pressed: { opacity: 0.5 },
  guide: {
    justifyContent: "center",
    minHeight: 56,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  plain: { color: colors.text, fontSize: 15 },
  failed: { color: "#FF453A" },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    alignItems: "center",
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { color: colors.text, fontSize: 17, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  mapped: { color: colors.text, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  opens: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 24,
    marginBottom: 4,
    marginHorizontal: 16,
  },
  form: { gap: 12, marginHorizontal: 16 },
  field: { gap: 6 },
  input: {
    minHeight: 44,
    color: colors.text,
    fontSize: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  refusal: { color: "#FF453A", fontSize: 15, fontWeight: "600" },
  buttons: { flexDirection: "row", flexWrap: "wrap", columnGap: 24 },
  note: { color: colors.dim, fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginTop: 4 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingTop: 8,
    marginHorizontal: 16,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 17, minHeight: 36 },
  none: { color: colors.dim, fontSize: 15, marginHorizontal: 16, marginTop: 12 },
  channel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Accessibility text sizes put a row's mapping under its name.
  stacked: { flexDirection: "column", alignItems: "stretch", gap: 2 },
  names: { flex: 1, minWidth: 0 },
  small: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  heading: { gap: 2, marginHorizontal: 16, marginTop: 8 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  subtitle: { color: colors.dim, fontSize: 15 },
  fieldLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  own: { gap: 2, marginHorizontal: 16, marginTop: 20, marginBottom: 20 },
  text: { color: colors.text, fontSize: 17 },
  dim: { color: colors.dim },
  end: { height: 32 },
});
