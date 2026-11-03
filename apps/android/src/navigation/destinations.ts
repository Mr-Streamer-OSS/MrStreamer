import type MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";

// Paper A Destinations: Home, Live, Movies and Series, each a tab with its own stack under
// `src/app/(tabs)/`. Live is the start destination: the app opens on it, and Back at another
// destination's root returns to it before leaving the app. Search, Downloads and Settings open on
// the stack of the destination showing, so Back returns to where they were opened from.

type IconName = ComponentProps<typeof MaterialIcons>["name"];

export interface Destination {
  /** The tab's route in `src/app/(tabs)/`. */
  readonly route: "home" | "(live)" | "movies" | "series";
  readonly label: string;
  /** Material icons, outlined while another destination is selected. */
  readonly icon: IconName;
  readonly selectedIcon: IconName;
}

export type Destinations = readonly Destination[];

/** In the order the navigation bar and rail show them. */
export const DESTINATIONS = [
  { route: "home", label: "Home", icon: "home", selectedIcon: "home-filled" },
  { route: "(live)", label: "Live", icon: "live-tv", selectedIcon: "live-tv" },
  { route: "movies", label: "Movies", icon: "movie", selectedIcon: "movie" },
  { route: "series", label: "Series", icon: "video-library", selectedIcon: "video-library" },
] as const satisfies Destinations;

export type DestinationRoute = (typeof DESTINATIONS)[number]["route"];

/** Where the app opens, and where Back from another destination's root goes. */
export const START_DESTINATION: DestinationRoute = "(live)";

/** The screens every destination's stack can open over its own. */
export type SharedScreen = "search" | "downloads" | "settings";

/** The path of `screen` on `destination`'s stack: Live's at the root, the others under theirs. */
export function hrefOn(destination: DestinationRoute, screen: SharedScreen): string {
  return destination === START_DESTINATION ? `/${screen}` : `/${destination}/${screen}`;
}

/**
 * Which navigation the window gets: the bottom bar on phones, the side rail from 600dp wide
 * (Material's medium window class), where Search, Downloads and Settings join the destinations.
 */
export type NavigationLayout = "bar" | "rail";

export const RAIL_MIN_WIDTH = 600;

export const layoutFor = (width: number): NavigationLayout =>
  width >= RAIL_MIN_WIDTH ? "rail" : "bar";
