import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  Modal,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { router, useSegments } from "expo-router";
import { sources } from "../bootstrap/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { FilledButton, Icon, OutlinedButton, Press, TextButton } from "../library/parts.tsx";
import { layoutFor } from "../navigation/destinations.ts";
import { useStore } from "../platform/store.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import {
  enterPreview,
  exitPreview,
  preview,
  providerPrompt,
  type ProviderAction,
} from "./session.ts";

// Paper A's Explore app page: the entry under Connect, the Preview mode strip, the Add provider
// sheet and the real Add provider form over the preview.

/** The strip's own surface, a step above true black, as Paper A has it. */
const stripSurface = "#0A0A0A";

/** Paper's 200% text, at which the strip puts its actions on their own line. */
const useLargeText = () => useWindowDimensions().fontScale >= 1.5;

function leave() {
  exitPreview();
  router.replace("/connect");
}

/** Connect's Explore app row: a 72dp row under a hairline, 16dp below the Connect action. */
export function ExploreEntry() {
  return (
    <Press
      label={`${t("Explore app")}, ${t("Fictional examples, no login")}`}
      onPress={() => {
        enterPreview();
        router.replace("/(tabs)/(live)");
        AccessibilityInfo.announceForAccessibility(t("Preview mode"));
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 72,
        marginTop: 16,
        paddingLeft: 16,
        paddingRight: 8,
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
      }}
    >
      <Icon name="explore" />
      <View style={{ flex: 1, minWidth: 0, gap: 4, paddingVertical: 12 }}>
        <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}>
          {t("Explore app")}
        </Text>
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
          {t("Fictional examples, no login")}
        </Text>
      </View>
      <Icon name="chevron-right" color={colors.secondary} />
    </Press>
  );
}

/**
 * Back at Live's root leaves preview for Connect, where it was entered; sheets, details and pushed
 * screens take Back first. Rendered once by the destinations' layout.
 */
export function PreviewBack() {
  const browsing = useStore(preview);
  const segments = useSegments();
  useEffect(() => {
    if (!browsing || segments.at(-1) !== "(live)") return;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      leave();

      return true;
    });

    return () => subscription.remove();
  }, [browsing, segments]);

  return null;
}

/**
 * Each destination's scene, under the Preview mode strip while browsing examples. The strip takes
 * the top inset, so the scene's own top app bar sits right under it; beside the rail on tablets
 * it heads the content only. Outside preview the scene keeps every inset, in the same tree.
 */
export function PreviewFrame({ children }: { children: ReactNode }) {
  const browsing = useStore(preview);
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {browsing ? <Strip /> : null}
      <SafeAreaInsetsContext.Provider value={browsing ? { ...insets, top: 0 } : insets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

function Strip() {
  const rail = layoutFor(useWindowDimensions().width) === "rail";
  const large = useLargeText();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: rail ? 0 : insets.left,
        paddingRight: insets.right,
        backgroundColor: colors.background,
      }}
    >
      <View
        style={{
          flexDirection: large ? "column" : "row",
          alignItems: large ? "stretch" : "center",
          columnGap: 16,
          minHeight: 56,
          paddingLeft: rail ? 24 : 16,
          paddingRight: rail ? 12 : 4,
          backgroundColor: stripSurface,
          borderBottomWidth: 1,
          borderBottomColor: colors.hairline,
        }}
      >
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${t("Preview mode")}, ${t("Fictional examples")}`}
          style={{
            flex: large ? undefined : 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            minHeight: 48,
            paddingTop: large ? 8 : 0,
          }}
        >
          <Icon name="explore" />
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: rail ? "row" : "column",
              flexWrap: "wrap",
              alignItems: rail ? "baseline" : "flex-start",
              columnGap: 12,
              rowGap: 2,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "700" }}>
              {t("Preview mode")}
            </Text>
            <Text
              style={{
                color: colors.secondary,
                fontSize: rail ? 14 : 12,
                lineHeight: rail ? 18 : 16,
              }}
            >
              {t("Fictional examples")}
            </Text>
          </View>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            alignSelf: large ? "flex-end" : "auto",
            gap: 16,
          }}
        >
          <TextButton label={t("Add provider")} onPress={() => providerPrompt.set("add")} />
          <IconButton
            icon="close"
            label={t("Exit preview")}
            color={colors.secondary}
            onPress={leave}
          />
        </View>
      </View>
    </View>
  );
}

const prompts = {
  play: {
    title: () => t("Add a provider to play"),
    body: () => t("Examples have no video. Add your provider to play your own channels and films."),
  },
  download: {
    title: () => t("Add a provider to download"),
    body: () =>
      t(
        "Examples have no video to save. Add your provider to download your own films and episodes.",
      ),
  },
  cast: {
    title: () => t("Add a provider to cast"),
    body: () =>
      t("Examples have no video. Add your provider to watch your own channels and films on a TV."),
  },
  remind: {
    title: () => t("Add a provider to set reminders"),
    body: () =>
      t(
        "Examples aren't saved, so no reminder is set. Add your provider to get reminders for your own guide.",
      ),
  },
  save: {
    title: () => t("Add a provider to save"),
    body: () =>
      t("Examples aren't saved. Add your provider to keep your own favourites and watchlist."),
  },
} satisfies Record<ProviderAction, { title: () => string; body: () => string }>;

/**
 * The one Add provider sheet every example action opens, titled for that action, and the real
 * Add provider form it leads to. Both are modals over the mounted browse tree, so Keep exploring,
 * Cancel and Back return to the exact screen, scroll and selection they opened over. Rendered once
 * by the root layout.
 */
export function ProviderRequiredSheet() {
  const prompt = useStore(providerPrompt);
  // The last action's words stay while the sheet slides away.
  const [action, setAction] = useState<ProviderAction>("play");

  const browsing = useStore(preview);

  if (prompt !== null && prompt !== "add" && prompt !== action) setAction(prompt);

  // Connected viewers mount neither modal; a stale example link still opens the sheet.
  if (!browsing && prompt === null) return null;

  const close = () => providerPrompt.set(null);

  return (
    <>
      <Sheet
        visible={prompt !== null && prompt !== "add"}
        label={t("Add provider")}
        onClose={close}
        fit
      >
        <Prompt action={action} onClose={close} />
      </Sheet>
      <Modal
        visible={prompt === "add"}
        animationType="slide"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={close}
      >
        <SafeAreaProvider>
          <FormFrame>
            <ConnectScreen
              owner={sources}
              onDone={close}
              onConnected={() => {
                exitPreview();
                router.replace("/");
              }}
            />
          </FormFrame>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

/** The form's full window under the status bar; Connect pads the navigation bar itself. */
function FormFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: colors.background,
      }}
    >
      {children}
    </View>
  );
}

/** The sheet's words and actions: stacked on a phone, side by side in the 560dp tablet sheet. */
function Prompt({ action, onClose }: { action: ProviderAction; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const wide = layoutFor(useWindowDimensions().width) === "rail" && !useLargeText();

  const add = (
    <FilledButton
      label={t("Add provider")}
      icon="login"
      onPress={() => providerPrompt.set("add")}
    />
  );

  const keep = <OutlinedButton label={t("Keep exploring")} onPress={onClose} />;

  return (
    <View style={{ paddingBottom: insets.bottom }}>
      <View style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 24 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
        >
          {prompts[action].title()}
        </Text>
      </View>
      <Text
        style={{
          paddingHorizontal: 24,
          paddingBottom: 20,
          color: colors.secondary,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {prompts[action].body()}
      </Text>
      {wide ? (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 24, paddingBottom: 24 }}>
          <View style={{ flex: 1 }}>{keep}</View>
          <View style={{ flex: 1, flexDirection: "row" }}>{add}</View>
        </View>
      ) : (
        <View style={{ gap: 8, paddingHorizontal: 24, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row" }}>{add}</View>
          {keep}
        </View>
      )}
    </View>
  );
}
