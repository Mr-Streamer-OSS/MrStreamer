// The top bar of the window. Unlike the rest of the UI, which grows with the window, it is sized
// in pixels, because the system draws its window controls at a fixed size: the bar has to keep
// them centred and clear of the brand and navigation.
export const WINDOW_BAR = {
  height: 52,
  /** macOS traffic lights, about 14 px tall and 58 px wide, centred in the bar. */
  trafficLights: { x: 18, y: 19 },
  /** Room for the macOS traffic lights on the left. */
  macInset: 92,
  /** Room for the Windows window buttons on the right. */
  windowsInset: 146,
} as const;
