import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, type ComponentRef } from "react";
import {
  AccessibilityInfo,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { layoutFor } from "../navigation/destinations.ts";
import { Screen } from "../navigation/screen.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { useInterfaceLanguage } from "./language.ts";
import { licenceAt, licences } from "./licences.ts";
import { PaneTitle } from "./pane-title.tsx";
import { Pressed, useSnackbar } from "./parts.tsx";

type Component = (typeof licences)[number];

/** From 840dp a licence shows beside the list, as `Screen` places a detail pane. */
const BESIDE = 840;

/**
 * Every component this Android build ships, from the generated manifest, each with its licence;
 * one opens its licence, version, source and notices in full as the list's detail pane, kept in
 * the route's `licence` param (its place in the manifest) so it survives rotation.
 */
export function LicencesScreen() {
  useInterfaceLanguage();
  const { licence } = useLocalSearchParams<{ licence?: string }>();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { snackbar, show: notify } = useSnackbar();
  const rows = useRef(new Map<number, ComponentRef<typeof Pressable>>());
  const at = licence === undefined ? -1 : Number(licence);
  const selected = licenceAt(at);
  const beside = width >= BESIDE;

  const openLink = (url: string) =>
    void Linking.openURL(url).catch(() => notify({ text: t("Couldn't open the browser.") }));

  return (
    <Screen
      title={t("Licences")}
      pushed
      detail={
        selected
          ? {
              title: selected.name,
              content: (
                <View style={{ flex: 1 }}>
                  <LicencePane component={selected} beside={beside} onOpen={openLink} />
                  {/* Over the list, the pane hides it, so a snackbar shows here instead. */}
                  {beside ? null : snackbar}
                </View>
              ),
              onClose: () => {
                router.setParams({ licence: undefined });
                const row = rows.current.get(at);

                if (row) AccessibilityInfo.sendAccessibilityEvent(row, "focus");
              },
            }
          : undefined
      }
    >
      <FlatList
        data={licences}
        keyExtractor={(component) => `${component.name}@${component.version}`}
        extraData={`${at} ${beside}`}
        contentContainerStyle={{
          paddingLeft: layoutFor(width) === "rail" ? 8 : 0,
          paddingBottom: insets.bottom + 24,
        }}
        renderItem={({ item, index }) => {
          const marked = index === at && beside;

          return (
            <Pressed
              rowRef={(row) => {
                if (row) rows.current.set(index, row);
                else rows.current.delete(index);
              }}
              onPress={() => router.setParams({ licence: String(index) })}
              label={item.name}
              value={item.licence}
              selected={index === at}
              fill={marked}
              minHeight={52}
            >
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  color: colors.text,
                  fontSize: 16,
                  lineHeight: 20,
                  fontWeight: marked ? "500" : "400",
                }}
              >
                {item.name}
              </Text>
              <Text
                style={{ flexShrink: 0, color: colors.secondary, fontSize: 14, lineHeight: 18 }}
              >
                {item.licence}
              </Text>
            </Pressed>
          );
        }}
      />
      {selected && !beside ? null : snackbar}
    </Screen>
  );
}

/** A component's licence, version and source, then its notices in full. */
function LicencePane({
  component,
  beside,
  onOpen,
}: {
  component: Component;
  beside: boolean;
  onOpen: (url: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const margin = beside ? 24 : 16;

  const fact = (label: string, value: string) => (
    <View
      accessible
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 48,
        paddingHorizontal: margin,
      }}
    >
      <Text style={{ flex: 1, color: colors.text, fontSize: 16, lineHeight: 20 }}>{label}</Text>
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{value}</Text>
    </View>
  );

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {beside ? <PaneTitle title={component.name} /> : null}
      {fact(t("Licence"), component.licence)}
      {fact(t("Version"), component.version)}
      <Pressed
        onPress={() => onOpen(component.source)}
        label={t("Source code")}
        value={component.source}
        role="link"
        minHeight={56}
        style={{ paddingHorizontal: margin, paddingVertical: 8 }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20 }}>
            {t("Source code")}
          </Text>
          <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
            {component.source.replace(/^https?:\/\//, "")}
          </Text>
        </View>
        <MaterialIcons
          importantForAccessibility="no-hide-descendants"
          name="open-in-new"
          size={24}
          color={colors.secondary}
        />
      </Pressed>
      <View
        style={{
          gap: 12,
          paddingVertical: 16,
          paddingHorizontal: margin,
          borderTopWidth: 1,
          borderColor: colors.hairline,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            color: colors.secondary,
            fontSize: 12,
            lineHeight: 16,
            fontWeight: "700",
            letterSpacing: 0.72,
          }}
        >
          {t("Notice").toLocaleUpperCase()}
        </Text>
        <Text selectable style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>
          {component.notice}
        </Text>
      </View>
    </ScrollView>
  );
}
