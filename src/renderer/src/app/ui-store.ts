import { create } from "zustand";

/** The page under everything else: Home or the Live TV guide. Watch opens over it. */
export type View = "home" | "live";

/** The tabs of the Settings page. */
export type SettingsTab = "subscription" | "updates" | "about";

/** A list of channels the guide and Watch's channel list show. */
export type ChannelList =
  | { readonly kind: "favourites" }
  | { readonly kind: "recent" }
  | { readonly kind: "all" }
  | { readonly kind: "category"; readonly id: string };

/** The update dialog on screen: the restart question. */
type UpdateDialog = "restart";

interface UiState {
  readonly view: View;
  /** Watch covers the page with the picture. Closing it returns to the page as it was. */
  readonly watching: boolean;
  /** Watch's channel list is open over the picture. */
  readonly channelsOpen: boolean;
  readonly searchOpen: boolean;
  /** The Settings tab on screen, over the current view; null while Settings is closed. */
  readonly settings: SettingsTab | null;
  /** Set while the login form edits an existing subscription. */
  readonly editingLogin: boolean;
  /** The list the guide and Watch's channel list show. */
  readonly list: ChannelList;
  readonly updateDialog: UpdateDialog | null;
}

/** Navigation and overlay state for the window. */
export const useUi = create<UiState>(() => ({
  view: "home",
  watching: false,
  channelsOpen: false,
  searchOpen: false,
  settings: null,
  editingLogin: false,
  list: { kind: "all" },
  updateDialog: null,
}));

/** Shows a page, closing Watch and Settings over it. */
export function openView(view: View): void {
  useUi.setState({ view, watching: false, channelsOpen: false, settings: null });
}

/** Opens Watch over the current page. */
export function openWatch(): void {
  useUi.setState({ watching: true, searchOpen: false, settings: null });
}

/** Closes Watch, back to the page it opened over. */
export function closeWatch(): void {
  useUi.setState({ watching: false, channelsOpen: false });
}

/** Whether two lists are the same. */
export function sameList(a: ChannelList, b: ChannelList): boolean {
  return a.kind === b.kind && (a.kind !== "category" || (b.kind === "category" && a.id === b.id));
}
