import { currentLanguage, onLanguageChange } from "@mrstreamer/core/i18n";
import { useSyncExternalStore } from "react";
import { router, useSegments } from "expo-router";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { NavigationBar, NavigationRail } from "../ui/navigation-bar.tsx";
import {
  DESTINATIONS,
  hrefOn,
  START_DESTINATION,
  type DestinationRoute,
  type NavigationLayout,
} from "./destinations.ts";

/**
 * The tabs' bar or rail. Selecting another destination shows its stack as it was left; selecting
 * the one showing returns its stack to the root (the stack's own answer to `tabPress`).
 */
export function DestinationBar({
  state,
  emitter,
  navigateToTab,
  insets,
  layout,
}: BottomTabBarProps & { layout: NavigationLayout }) {
  useSyncExternalStore(onLanguageChange, currentLanguage);
  const focused = state.routes[state.index];
  const downloadsSelected = useSegments().at(-1) === "downloads";

  const selected =
    DESTINATIONS.find(({ route }) => route === focused?.name)?.route ?? START_DESTINATION;

  const onSelect = (route: DestinationRoute) => {
    const target = state.routes.find(({ name }) => name === route);

    if (!target) return;
    const event = emitter.emit({ type: "tabPress", target: target.key, canPreventDefault: true });

    if (target.key !== focused?.key && !event.defaultPrevented) navigateToTab(target.key);
  };

  const props = { destinations: DESTINATIONS, selected, onSelect, insets };

  return layout === "rail" ? (
    <NavigationRail
      {...props}
      downloadsSelected={downloadsSelected}
      onOpen={(screen) => router.navigate(hrefOn(selected, screen))}
    />
  ) : (
    <NavigationBar {...props} />
  );
}
