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
  readonly kind: "xtream";
  /** Normalised server origin, for example `http://line.example.tv:8080`. */
  readonly server: string;
  readonly username: string;
  readonly account: AccountStatus;
}
