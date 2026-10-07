/** A bounded local export, built only when the viewer asks. The text is the exact saved file. */
export interface DiagnosticsPreview {
  readonly id: string;
  readonly version: string;
  readonly commit: string;
  readonly channel: "stable" | "nightly";
  readonly platform: string;
  readonly distribution: "direct" | "store";
  readonly subscriptions: { readonly xtream: number; readonly m3u: number };
  readonly entries: number;
  readonly failures: number;
  readonly acceleratedVideoDecodeDisabled: boolean;
  readonly checked: string;
  readonly text: string;
}
