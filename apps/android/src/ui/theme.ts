// Paper A's colours: true black, white text, greys for secondary text, unselected destination
// icons and hairlines between sections, the raised surface of a modal sheet, and red for failures.
export const colors = {
  background: "#000000",
  text: "#FFFFFF",
  secondary: "#A3A3A3",
  /** An unselected destination's icon, a step below its label. */
  inactive: "#8A8A8A",
  hairline: "#1C1C1C",
  /** A modal sheet over the scrim. */
  surface: "#141414",
  /** A snackbar, and the row whose detail pane shows beside its list. */
  raised: "#262626",
  /** What failed: a provider's status, a choice that can't be kept. */
  failure: "#FF5A4E",
  /** The drag handle at the top of a sheet. */
  handle: "#5C5C5C",
  scrim: "rgba(0, 0, 0, 0.6)",
  /** Press feedback on a control: Android's ripple, white at 16%. */
  ripple: "rgba(255, 255, 255, 0.16)",
  /** Behind the control the keyboard or D-pad has focused. */
  focus: "rgba(255, 255, 255, 0.24)",
} as const;
