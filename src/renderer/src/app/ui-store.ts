import { create } from "zustand";

const DEPTHS = [0, 1, 2, 3] as const;

/** How many guide columns are open, MYTVOnline style: channels, then categories, then the rail. */
export type GuideDepth = (typeof DEPTHS)[number];

/** Clamps any number to a guide depth. */
export function toDepth(value: number): GuideDepth {
  return DEPTHS[Math.min(3, Math.max(0, Math.round(value)))] ?? 0;
}

export type View = "home" | "live";

/** The tabs of the Settings page. */
export type SettingsTab = "subscription" | "updates" | "about";

/** The update dialog on screen: the restart question. */
type UpdateDialog = "restart";

interface UiState {
  readonly view: View;
  readonly searchOpen: boolean;
  /** The Settings tab on screen, over the current view; null while Settings is closed. */
  readonly settings: SettingsTab | null;
  /** Set while the login form edits an existing subscription. */
  readonly editingLogin: boolean;
  /** Selected Live TV category. Null shows all channels. */
  readonly categoryId: string | null;
  readonly guideDepth: GuideDepth;
  readonly updateDialog: UpdateDialog | null;
}

/** Navigation and overlay state for the window. */
export const useUi = create<UiState>(() => ({
  view: "home",
  searchOpen: false,
  settings: null,
  editingLogin: false,
  categoryId: null,
  guideDepth: 0,
  updateDialog: null,
}));
