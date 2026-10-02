// Subscription types shared by the main process and the UI. The password never leaves the main process.

export type AccountState = "active" | "expired" | "banned" | "disabled" | "unknown";

/** What the provider reported about the account at the last successful check. */
export interface AccountStatus {
  readonly state: AccountState;
  /** ISO timestamp, or null for accounts without an expiry date. */
  readonly expiresAt: string | null;
  readonly maxConnections: number | null;
  readonly activeConnections: number | null;
}

export interface SubscriptionSummary {
  /** An Xtream Codes login, or an M3U playlist link without one, which has live TV only. */
  readonly kind: "xtream" | "m3u";
  /** Identifies the account: the same login or link gives the same id. Holds no secret. */
  readonly id: string;
  /**
   * Normalised server origin, for example `http://line.example.tv:8080`. For a playlist, its
   * link's origin: the link itself stays in the main process.
   */
  readonly server: string;
  /** Empty for a playlist. */
  readonly username: string;
  readonly account: AccountStatus;
  /**
   * True when the saved password, or a playlist's link, can no longer be read, for example after
   * the keychain denied access. The subscription stays, but nothing plays until the user enters
   * it again.
   */
  readonly needsPassword: boolean;
}
