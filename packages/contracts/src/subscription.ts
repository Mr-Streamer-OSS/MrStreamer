// Subscription types shared by the main process and the UI. The password never leaves the main
// process, nor does a playlist's link: the UI sees only its origin.

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
  /** An Xtream Codes login, or an M3U playlist link without one, which defaults to Live TV until mapped. */
  readonly kind: "xtream" | "m3u";
  /**
   * Identifies the saved subscription on this device: made up when it is added, and kept through
   * a new name, password or link until it is removed. Holds nothing of the login. Everything a
   * provider lists is named with it (`OwnedId`).
   */
  readonly id: string;
  /** What the viewer calls it, or null without a name: lists then show its server's host. */
  readonly name: string | null;
  /**
   * Normalised server origin, for example `http://line.example.tv:8080`. For a playlist, its
   * link's origin: the link itself stays in the main process.
   */
  readonly server: string;
  /** Empty for a playlist. */
  readonly username: string;
  readonly account: AccountStatus;
  /**
   * True when the saved secret can no longer be read, for example after the keychain denied
   * access: the password, or for a playlist its whole link. The subscription stays with the lists
   * it loaded before, but nothing of it plays or refreshes until the user enters it again. `kind`
   * says which to ask for.
   */
  readonly needsSecret: boolean;
  /** Explicit M3U group mapping enables movie and series navigation. */
  readonly playlistMapped?: boolean;
}

/** Xtream and explicitly mapped playlists support titles, even if every group is Live or Skip. */
export function hasTitles(
  subscription: Pick<SubscriptionSummary, "kind" | "playlistMapped">,
): boolean {
  return subscription.kind === "xtream" || subscription.playlistMapped === true;
}

/**
 * Something a provider lists, named in full: its id as the provider gives it, and the subscription
 * it comes from. A provider's ids are unique only within its own lists, so a channel, category,
 * movie, series or episode is never looked up by `id` alone.
 */
export interface OwnedId {
  /** The `SubscriptionSummary.id` of the subscription that lists it. */
  readonly subscriptionId: string;
  /** The provider's own id, as it sent it. */
  readonly id: string;
}

/** `owned`'s id alone, without whatever else it carries: what a request sends to name it. */
export function ownedId({ subscriptionId, id }: OwnedId): OwnedId {
  return { subscriptionId, id };
}

/**
 * One string per owned id, for the keys of lists and maps. A subscription's id holds no colon, so
 * two subscriptions never share a key. It is no id to send back: requests name an `OwnedId`.
 */
export function ownedKey(owned: OwnedId): string {
  return `${owned.subscriptionId}:${owned.id}`;
}

/** Whether two owned ids name the same thing. Null and undefined name nothing. */
export function sameOwned(a: OwnedId | null | undefined, b: OwnedId | null | undefined): boolean {
  return !!a && !!b && a.subscriptionId === b.subscriptionId && a.id === b.id;
}
