import { useWindowDimensions } from "react-native";
import { store, useStore } from "./store.ts";

/**
 * The window's left and right safe area, which the tab stacks keep their screens' content inside
 * (`tabScreenOptions` in header.tsx). The tabs' layout keeps it current. It is 0 on iPhone and iPad
 * portrait. On iPhone Duo's closed panel it is 84 on the right, the column where UIKit puts the
 * status bar, the top bar's buttons and the tab bar; in iPhone landscape it covers the sensor
 * housing and the corners on both sides.
 */
export const tabSides = store({ left: 0, right: 0 });

/** How wide a tab's screens lay out their content: the window less `tabSides`. */
export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  const { left, right } = useStore(tabSides);
  return width - left - right;
}
