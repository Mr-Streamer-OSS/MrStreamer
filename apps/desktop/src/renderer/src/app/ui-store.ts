import { create } from "zustand";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";

/** The page under everything else. Watch, details and playing a title open over it. */
export type View = "home" | "live" | "movies" | "series";

/** The tabs of the Settings page, and the licences About opens. */
export type SettingsTab = "general" | "subscription" | "about" | "licences";

/** A list of channels the guide and Watch's channel list show. */
export type ChannelList =
  | { readonly kind: "favourites" }
  | { readonly kind: "recent" }
  | { readonly kind: "all" }
  | { readonly kind: "category"; readonly id: string };

/** A movie or series whose details are on screen. */
export interface DetailsTarget {
  readonly kind: TitleKind;
  readonly id: string;
}

/** The update dialog on screen: the panel under the top bar's Update, or the restart question. */
type UpdateDialog = "panel" | "restart";

interface UiState {
  /** Rises each time the account changes, so work started for the one before gives way. */
  readonly account: number;
  readonly view: View;
  /** Watch covers the page with a live channel. Closing it returns to the page as it was. */
  readonly watching: boolean;
  /** A movie or episode plays over everything, until the viewer leaves it. */
  readonly playingTitle: boolean;
  /** A movie's or series' details, over the page they were opened from. */
  readonly details: DetailsTarget | null;
  /** Watch's channel list is open over the picture. */
  readonly channelsOpen: boolean;
  readonly searchOpen: boolean;
  /** What search starts with when it opens: what Movies or Series searches for, while shown. */
  readonly searchFrom: string;
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
  account: 0,
  view: "home",
  watching: false,
  playingTitle: false,
  details: null,
  channelsOpen: false,
  searchOpen: false,
  searchFrom: "",
  settings: null,
  editingLogin: false,
  list: { kind: "all" },
  updateDialog: null,
}));

/** Shows a page, closing Watch, details and Settings over it. */
export function openView(view: View): void {
  useUi.setState({ view, watching: false, channelsOpen: false, settings: null, details: null });
}

/**
 * Home with nothing open over it, for a new account or none: a list, details or a title open
 * before belonged to the account that went.
 */
export function resetForAccount(): void {
  useUi.setState((state) => ({
    account: state.account + 1,
    view: "home",
    watching: false,
    playingTitle: false,
    details: null,
    channelsOpen: false,
    searchOpen: false,
    list: { kind: "all" },
  }));
}

/** Opens Watch over the current page. */
export function openWatch(): void {
  useUi.setState({ watching: true, searchOpen: false, settings: null });
}

/** Closes Watch, back to the page it opened over. */
export function closeWatch(): void {
  useUi.setState({ watching: false, channelsOpen: false });
}

/** Shows a movie's or series' details over the page. */
export function openDetails(target: DetailsTarget): void {
  useUi.setState({ details: target, searchOpen: false, settings: null, watching: false });
}

/** Whether two lists are the same. */
export function sameList(a: ChannelList, b: ChannelList): boolean {
  return a.kind === b.kind && (a.kind !== "category" || (b.kind === "category" && a.id === b.id));
}
