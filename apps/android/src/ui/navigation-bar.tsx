import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { Destination, DestinationRoute, SharedScreen } from "../navigation/destinations.ts";
import { IconButton } from "./icon-button.tsx";
import { colors } from "./theme.ts";

interface Props {
  destinations: readonly Destination[];
  selected: DestinationRoute;
  onSelect: (route: DestinationRoute) => void;
  insets: EdgeInsets;
}

/**
 * Phones: the destinations along the bottom, over the system's navigation bar. Paper A: 80dp tall
 * with its top hairline, the selected destination marked only by white and bold.
 */
export function NavigationBar({ destinations, selected, onSelect, insets }: Props) {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        borderTopWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
    >
      {destinations.map((destination) => (
        <Item
          key={destination.route}
          destination={destination}
          selected={destination.route === selected}
          onPress={() => onSelect(destination.route)}
          placement="bar"
        />
      ))}
    </View>
  );
}

/**
 * From 600dp wide: the destinations down the side, with Search above them and Downloads and
 * Settings at the foot. Paper A: 88dp wide with its right hairline, 4dp between slots, the
 * selected destination marked by a 3dp white bar on its leading edge.
 */
export function NavigationRail({
  destinations,
  selected,
  onSelect,
  onOpen,
  insets,
}: Props & { onOpen: (screen: SharedScreen) => void }) {
  // Scrolls when the window is shorter than the rail, as a phone in landscape is (about 484dp of
  // rail against 360dp), and more so at large text, so Downloads and Settings stay reachable.
  return (
    <ScrollView
      style={{
        flexGrow: 0,
        width: 88 + insets.left,
        borderRightWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
      contentContainerStyle={{
        flexGrow: 1,
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 8,
        paddingLeft: insets.left,
        alignItems: "center",
        gap: 4,
      }}
    >
      <IconButton
        icon="search"
        label="Search"
        onPress={() => onOpen("search")}
        width={56}
        height={72}
      />
      <View accessibilityRole="tablist" style={{ alignSelf: "stretch", gap: 4 }}>
        {destinations.map((destination) => (
          <Item
            key={destination.route}
            destination={destination}
            selected={destination.route === selected}
            onPress={() => onSelect(destination.route)}
            placement="rail"
          />
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <IconButton
        icon="download"
        label="Downloads"
        onPress={() => onOpen("downloads")}
        color={colors.secondary}
        width={56}
        height={56}
      />
      <IconButton
        icon="settings"
        label="Settings"
        onPress={() => onOpen("settings")}
        color={colors.secondary}
        width={56}
        height={56}
      />
    </ScrollView>
  );
}

/**
 * One destination: its 24dp icon 4dp over its 12dp label, 79dp tall in the bar (80 with the
 * hairline) and 64dp in the rail, growing with the text size.
 */
function Item({
  destination,
  selected,
  onPress,
  placement,
}: {
  destination: Destination;
  selected: boolean;
  onPress: () => void;
  placement: "bar" | "rail";
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={destination.label}
      onPress={onPress}
      android_ripple={{ color: colors.ripple }}
      style={[
        { alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 8 },
        placement === "bar"
          ? { flex: 1, minHeight: 79 }
          : {
              minHeight: 64,
              // The bar's width is balanced on the trailing side so the icon stays centred.
              ...(selected
                ? { borderLeftWidth: 3, borderColor: colors.text, paddingRight: 3 }
                : null),
            },
      ]}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={selected ? destination.selectedIcon : destination.icon}
        size={24}
        color={selected ? colors.text : colors.inactive}
      />
      <Text
        importantForAccessibility="no"
        numberOfLines={1}
        style={{
          color: selected ? colors.text : colors.secondary,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: selected ? "700" : "500",
        }}
      >
        {destination.label}
      </Text>
    </Pressable>
  );
}
