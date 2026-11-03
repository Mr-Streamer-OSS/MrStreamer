import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Pressable, Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { Destination, Destinations, SharedScreen } from "../navigation/destinations.ts";
import { IconButton } from "./icon-button.tsx";
import { colors } from "./theme.ts";

interface Props {
  destinations: Destinations;
  selected: Destination["route"];
  onSelect: (route: Destination["route"]) => void;
  insets: EdgeInsets;
}

/** Phones: the destinations along the bottom, over the system's navigation bar. */
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
        />
      ))}
    </View>
  );
}

/**
 * From 600dp wide: the destinations down the side, with Search above them and Downloads and
 * Settings at the foot.
 */
export function NavigationRail({
  destinations,
  selected,
  onSelect,
  onOpen,
  insets,
}: Props & { onOpen: (screen: SharedScreen) => void }) {
  return (
    <View
      style={{
        width: 88 + insets.left,
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 8,
        paddingLeft: insets.left,
        alignItems: "center",
        borderRightWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
    >
      <IconButton icon="search" label="Search" onPress={() => onOpen("search")} />
      <View accessibilityRole="tablist" style={{ alignSelf: "stretch", marginTop: 24, gap: 12 }}>
        {destinations.map((destination) => (
          <Item
            key={destination.route}
            destination={destination}
            selected={destination.route === selected}
            onPress={() => onSelect(destination.route)}
          />
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <IconButton icon="download" label="Downloads" onPress={() => onOpen("downloads")} />
      <IconButton icon="settings" label="Settings" onPress={() => onOpen("settings")} />
    </View>
  );
}

/** One destination: its icon over its label, at least 48dp tall, growing with the text size. */
function Item({
  destination,
  selected,
  onPress,
}: {
  destination: Destination;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={destination.label}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 64,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        paddingVertical: 8,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={selected ? destination.selectedIcon : destination.icon}
        size={24}
        color={selected ? colors.text : colors.secondary}
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
