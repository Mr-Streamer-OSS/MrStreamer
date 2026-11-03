// Paper A's colours: true black, white text, greys for secondary text, unselected destination
// icons and hairlines between sections, and the raised surface of a modal sheet.
export const colors = {
  background: "#000000",
  text: "#FFFFFF",
  secondary: "#A3A3A3",
  /** An unselected destination's icon, a step below its label. */
  inactive: "#8A8A8A",
  hairline: "#1C1C1C",
  /** A modal sheet over the scrim. */
  surface: "#141414",
  /** The drag handle at the top of a sheet. */
  handle: "#5C5C5C",
  scrim: "rgba(0, 0, 0, 0.6)",
} as const;
