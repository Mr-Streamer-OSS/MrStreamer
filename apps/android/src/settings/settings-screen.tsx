import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import {
  AccessibilityInfo,
  Linking,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentLanguage, formatNumber, t as coreText } from "@mrstreamer/core/i18n";
import type { LanguageChoice } from "@mrstreamer/mobile/language/resolve";
import { sources } from "../bootstrap/sources.ts";
import { monogram } from "../connect/catalogue-screen.tsx";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { describeFailure } from "../connect/failure.ts";
import type { ConnectedSource } from "../connect/sources.ts";
import { layoutFor } from "../navigation/destinations.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { statistics } from "../telemetry/index.ts";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { build } from "./build.ts";
import { t } from "./copy.ts";
import { DiagnosticsPane } from "./diagnostics-pane.tsx";
import { chooseLanguage, languageChoice, useInterfaceLanguage } from "./language.ts";
import { licenceCount } from "./licences.ts";
import { onStack } from "./paths.ts";
import {
  Dialog,
  DialogText,
  Note,
  Pressed,
  Row,
  Section,
  SheetAction,
  SwitchRow,
  useSnackbar,
} from "./parts.tsx";
import { providerRecovery, recoveryAction } from "./recovery.ts";

const PRIVACY_POLICY = "https://mrstreamer.app/privacy";

/** From 840dp Diagnostics shows beside the list, as `Screen` places a detail pane. */
const BESIDE = 840;

const recovery = providerRecovery(sources, () => statistics.discard());

type Open =
  | { readonly kind: "language" }
  | { readonly kind: "actions"; readonly id: string }
  /** The provider form: a new source, or `id`'s login again. */
  | { readonly kind: "form"; readonly id: string | null };

/**
 * Settings, opened over the destination showing: the interface language, each provider's status
 * and its recovery, the statistics choice, the privacy policy and Diagnostics, the version and
 * the licences. Only rows Android has behavior for are here; a feature adds its own section.
 * Diagnostics is its detail pane, kept in the route's `show` param so it survives rotation. A
 * write that doesn't hold keeps what was there and says so in a snackbar with Try again.
 */
export function SettingsScreen() {
  useInterfaceLanguage();
  const { show } = useLocalSearchParams<{ show?: string }>();
  const segments: readonly string[] = useSegments();
  const state = useStore(sources.state);
  useSyncExternalStore(statistics.consent.subscribe, statistics.consent.get);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<Open | null>(null);
  const [removing, setRemoving] = useState<ConnectedSource | null>(null);
  const { snackbar, show: notify } = useSnackbar();
  const diagnosticsRow = useRef<ComponentRef<typeof Pressable>>(null);
  const all = state.kind === "ready" ? state.sources : [];
  const close = () => setOpen(null);

  function choose(choice: LanguageChoice) {
    close();

    if (!chooseLanguage(choice)) {
      notify({
        text: t("Couldn't save the language. Your previous choice is still saved."),
        action: { label: t("Try again"), run: () => choose(choice) },
      });
    }
  }

  async function remove(source: ConnectedSource) {
    const result = await recovery.remove(source.id);

    if (result === "refused" || result === "partial") {
      notify({
        text:
          result === "refused"
            ? t("Couldn't remove {name}. Its login is still saved.", { name: source.label })
            : t("{name}'s login is erased, but it's still listed.", { name: source.label }),
        action: { label: t("Try again"), run: () => void remove(source) },
      });
    }
  }

  const openLink = (url: string) =>
    void Linking.openURL(url).catch(() => notify({ text: t("Couldn't open the browser.") }));

  const diagnostics = show === "diagnostics";
  // Over the list, the pane hides it, so a snackbar shows in the pane instead.
  const folded = diagnostics && width < BESIDE;
  const selected = open?.kind === "actions" ? all.find(({ id }) => id === open.id) : undefined;
  const asked = open?.kind === "form" ? all.find(({ id }) => id === open.id) : undefined;
  const statisticsOn = statistics.consent.enabled;

  return (
    <Screen
      title={t("Settings")}
      pushed
      detail={
        diagnostics
          ? {
              title: t("Diagnostics"),
              content: (
                <View style={{ flex: 1 }}>
                  <DiagnosticsPane
                    beside={!folded}
                    onShareFailed={() =>
                      notify({ text: t("Couldn't share diagnostics. Try again.") })
                    }
                  />
                  {folded ? snackbar : null}
                </View>
              ),
              onClose: () => {
                router.setParams({ show: undefined });

                if (diagnosticsRow.current)
                  AccessibilityInfo.sendAccessibilityEvent(diagnosticsRow.current, "focus");
              },
            }
          : undefined
      }
    >
      <ScrollView
        contentContainerStyle={{
          // Beside the rail, rows line up with the top app bar's 24dp margin.
          paddingLeft: layoutFor(width) === "rail" ? 8 : 0,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <Section name={t("General")} first>
          <Row
            label={t("Interface language")}
            value={languageName(languageChoice())}
            onPress={() => setOpen({ kind: "language" })}
          />
        </Section>
        <Section name={t("Providers")}>
          {all.map((source) => (
            <ProviderRow
              key={source.id}
              source={source}
              onPress={() => setOpen({ kind: "actions", id: source.id })}
            />
          ))}
          <Pressed
            onPress={() => setOpen({ kind: "form", id: null })}
            label={t("Add provider")}
            minHeight={56}
          >
            <View style={{ width: 48, alignItems: "center", flexShrink: 0 }}>
              <MaterialIcons
                importantForAccessibility="no-hide-descendants"
                name="add"
                size={24}
                color={colors.text}
              />
            </View>
            <Text
              style={{
                flex: 1,
                color: colors.text,
                fontSize: 16,
                lineHeight: 20,
                fontWeight: "500",
              }}
            >
              {t("Add provider")}
            </Text>
          </Pressed>
        </Section>
        <Section name={t("Privacy")}>
          <SwitchRow
            label={t("Share basic usage statistics")}
            on={statisticsOn}
            onChange={(on) => void statistics.configure(on)}
          />
          <Note>
            {t("Counts app use, the screens you open and provider actions.")}{" "}
            {t("No viewing history, searches or provider details. Off until you choose to share.")}
            {statistics.consent.available ? null : (
              <Text style={{ color: colors.failure }}>
                {" "}
                {t("They can't be saved on this phone right now.")}
              </Text>
            )}
          </Note>
          <Row
            label={t("Privacy policy")}
            trailing="external"
            onPress={() => openLink(PRIVACY_POLICY)}
          />
          <Row
            label={t("Diagnostics")}
            trailing="next"
            selected={diagnostics && width >= BESIDE}
            rowRef={diagnosticsRow}
            onPress={() => router.setParams({ show: "diagnostics" })}
          />
        </Section>
        <Section name={t("About")}>
          <Row label={t("Version")} value={`${build.version} (${build.code})`} />
          <Row
            label={t("Licences")}
            value={formatNumber(licenceCount)}
            trailing="next"
            onPress={() => router.push(onStack(segments, "licences"))}
          />
        </Section>
      </ScrollView>
      {snackbar}
      <Sheet
        visible={open?.kind === "language"}
        label={t("Interface language")}
        onClose={close}
        fit
      >
        <LanguagePicker choice={languageChoice()} onChoose={choose} />
      </Sheet>
      <Sheet visible={selected !== undefined} label={selected?.label ?? ""} onClose={close} fit>
        {selected ? (
          <ProviderActions
            source={selected}
            onLogin={() => setOpen({ kind: "form", id: selected.id })}
            onRetry={() => {
              close();
              recovery.retry(selected.id);
            }}
            onReload={() => {
              close();
              recovery.reloadChannels(selected.id);
            }}
            onRemove={() => {
              close();
              setRemoving(selected);
            }}
          />
        ) : null}
      </Sheet>
      <Sheet
        visible={open?.kind === "form"}
        label={asked?.label ?? t("Add provider")}
        onClose={close}
      >
        <ConnectScreen owner={sources} title={asked?.label} onDone={close} onConnected={close} />
      </Sheet>
      <Dialog
        visible={removing !== null}
        title={t("Remove {name}?", { name: removing?.label ?? "" })}
        stacked
        onDismiss={() => setRemoving(null)}
        buttons={[
          {
            label: t("Remove"),
            onPress: () => {
              const source = removing;
              setRemoving(null);

              if (source) void remove(source);
            },
          },
          { label: t("Cancel"), dismiss: true, onPress: () => setRemoving(null) },
        ]}
      >
        <DialogText>{t("Its login is erased from this phone.")}</DialogText>
      </Dialog>
    </Screen>
  );
}

/** "System default (English)", "English" or "Nederlands": what the row shows for `choice`. */
function languageName(choice: LanguageChoice): string {
  if (choice === "en-US") return t("English");

  if (choice === "nl-NL") return t("Nederlands");

  // System default names the language it resolved to, the one showing.
  return t("System default ({language})", {
    language: languageName(currentLanguage().locale === "nl-NL" ? "nl-NL" : "en-US"),
  });
}

/** A source: its badge, name and status, red when it failed; it opens the source's actions. */
function ProviderRow({ source, onPress }: { source: ConnectedSource; onPress: () => void }) {
  const status = statusOf(source);

  return (
    <Pressed onPress={onPress} label={source.label} value={status.text} minHeight={72}>
      <View
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 48,
          height: 36,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          backgroundColor: colors.surface,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 12, lineHeight: 16, fontWeight: "700" }}>
          {monogram(source.label)}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 4, paddingVertical: 12 }}>
        <Text
          numberOfLines={1}
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}
        >
          {source.label}
        </Text>
        <Status source={source} />
      </View>
    </Pressed>
  );
}

function statusOf({ channels }: ConnectedSource) {
  return channels.kind === "failed"
    ? { text: describeFailure(channels.error), failed: true }
    : {
        text:
          channels.kind === "loading"
            ? t("Loading channels")
            : coreText("{count} channels", { count: channels.rows.length }),
        failed: false,
      };
}

function Status({ source }: { source: ConnectedSource }) {
  const { text, failed } = statusOf(source);

  return (
    <Text
      style={{ color: failed ? colors.failure : colors.secondary, fontSize: 14, lineHeight: 18 }}
    >
      {text}
    </Text>
  );
}

/**
 * A source's actions, its status above them: Enter password (or its playlist link) when this
 * phone no longer has its login, Retry when its channels failed, otherwise Reload channels; then
 * Remove.
 */
function ProviderActions({
  source,
  onLogin,
  onRetry,
  onReload,
  onRemove,
}: {
  source: ConnectedSource;
  onLogin: () => void;
  onRetry: () => void;
  onReload: () => void;
  onRemove: () => void;
}) {
  const insets = useSafeAreaInsets();
  const needsLogin = recoveryAction(source) === "enter-login";
  const failed = source.channels.kind === "failed";

  return (
    <View style={{ paddingBottom: insets.bottom + 16 }}>
      <View style={{ gap: 4, paddingTop: 4, paddingBottom: 12, paddingHorizontal: 24 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
        >
          {source.label}
        </Text>
        <Status source={source} />
      </View>
      {needsLogin ? (
        <SheetAction
          icon={source.kind === "m3u" ? "link" : "vpn-key"}
          label={source.kind === "m3u" ? t("Enter playlist link") : t("Enter password")}
          onPress={onLogin}
          primary
        />
      ) : failed ? (
        <SheetAction icon="refresh" label={t("Retry")} onPress={onRetry} primary />
      ) : (
        <SheetAction icon="live-tv" label={t("Reload channels")} onPress={onReload} />
      )}
      <SheetAction icon="delete" label={t("Remove")} onPress={onRemove} />
    </View>
  );
}

/** Interface language's sheet: its title, then a checkmark on the choice saved. */
function LanguagePicker({
  choice,
  onChoose,
}: {
  choice: LanguageChoice;
  onChoose: (choice: LanguageChoice) => void;
}) {
  const insets = useSafeAreaInsets();
  const choices: readonly LanguageChoice[] = ["system", "en-US", "nl-NL"];

  return (
    <View style={{ paddingBottom: insets.bottom + 24 }}>
      <View style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 24 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
        >
          {t("Interface language")}
        </Text>
      </View>
      {choices.map((each) => (
        <SheetAction
          key={each}
          icon={each === choice ? "check" : null}
          label={languageName(each)}
          onPress={() => onChoose(each)}
          primary={each === choice}
          selected={each === choice}
        />
      ))}
    </View>
  );
}
