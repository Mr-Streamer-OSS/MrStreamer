import { router, useSegments } from "expo-router";
import {
  DESTINATIONS,
  hrefOn,
  START_DESTINATION,
  type DestinationRoute,
  type SharedScreen,
} from "./destinations.ts";

/** The destination whose stack shows, from the router's segments: `["(tabs)", "movies", …]`. */
export function destinationIn(segments: readonly string[]): DestinationRoute {
  return DESTINATIONS.find(({ route }) => route === segments[1])?.route ?? START_DESTINATION;
}

/**
 * Opens Search, Downloads or Settings on the stack of the destination showing, as the top app bar
 * and the rail do. One already open on that stack is returned to rather than opened twice.
 */
export function useOpenShared(): (screen: SharedScreen) => void {
  const segments: readonly string[] = useSegments();
  return (screen) => router.navigate(hrefOn(destinationIn(segments), screen));
}
