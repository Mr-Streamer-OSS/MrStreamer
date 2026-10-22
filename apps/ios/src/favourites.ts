import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useMemo } from "react";
import { Alert } from "react-native";
import { useCatalogue, useRoster, type Catalogue, type Member } from "./account.ts";
import { appError, describeError } from "./errors.ts";
import type { Channel } from "./library.ts";
import { setFavourite, useViewing } from "./viewing.ts";

// The favourites as Live, Home and Watch show them: the viewing record's favourites
// (viewing.ts), every provider's in one order, read by the channels Live shows now. A favourite
// opens only as a channel its own provider lists now and while that provider signs in: one of a
// provider that needs its password, whose lists haven't come or no longer list it, isn't made
// into a row, and is counted by provider with why. It keeps its place in the record, and a new
// order moves only the rows around it (`FavouriteOrder`). A star changes the record alone: nothing
// plays, stops or starts again.

/** A favourite that opens: its channel now, and the entry of the record it shows. */
export interface Favourite {
  readonly channel: Channel;
  /** As the record names it, which an order sends back. */
  readonly saved: OwnedId;
}

/** Why a provider's favourites don't show. */
export type Unavailable =
  /** Its channels haven't come yet. */
  | "loading"
  /** Its channels didn't load, and none of them showed before. */
  | "failed"
  /** It needs its password again. */
  | "needs-secret"
  /** Its channels show, and don't list these. */
  | "not-listed";

/** One provider's favourites that don't show, and why. */
export interface Hidden {
  readonly subscriptionId: string;
  readonly label: string;
  readonly why: Unavailable;
  /**
   * How many channels they are, when each is one the lists show. A saved stream no list shows
   * can be one of several of a channel, or of one still shown, so then it says none.
   */
  readonly count: number | null;
}

export interface FavouriteList {
  /** Every favourite as the record gives them, in order: what a new order is made from. */
  readonly original: readonly OwnedId[];
  /** Those that open, in order. */
  readonly shown: readonly Favourite[];
  /** The rest, by provider, in the providers' order. */
  readonly hidden: readonly Hidden[];
}

/**
 * The favourites of `viewing`, by the channels `catalogue` shows and how `members` stand. Null
 * while the record hasn't been read.
 */
export function favouriteList(
  viewing: Viewing | null,
  catalogue: Catalogue,
  members: readonly Member[],
): FavouriteList | null {
  if (!viewing) return null;
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const byId = new Map(members.map((member) => [member.entry.id, member]));
  const shown: Favourite[] = [];
  const seen = new Set<string>();
  const hidden = new Map<string, { why: Unavailable; channels: Set<string>; streams: boolean }>();
  for (const saved of viewing.favourites) {
    const { subscriptionId } = saved;
    const member = byId.get(subscriptionId);
    // The record names only saved subscriptions; one the roster dropped meanwhile shows nothing.
    if (!member) continue;
    const channel = library?.byKey.get(ownedKey(saved));
    if (channel && !member.needsSecret) {
      // The record read by older channels can name one channel twice for a moment.
      if (seen.has(channel.key)) continue;
      seen.add(channel.key);
      shown.push({ channel, saved });
      continue;
    }
    // Its channels show: the library has its part, a reload or failure keeping the last.
    const listed = library?.labels.has(subscriptionId) ?? false;
    const why: Unavailable = member.needsSecret
      ? "needs-secret"
      : listed
        ? "not-listed"
        : member.live.kind === "failed"
          ? "failed"
          : "loading";
    const known = hidden.get(subscriptionId) ?? { why, channels: new Set(), streams: false };
    if (channel) known.channels.add(channel.key);
    else known.streams = true;
    hidden.set(subscriptionId, known);
  }
  return {
    original: viewing.favourites,
    shown,
    hidden: members.flatMap(({ entry, label }) => {
      const found = hidden.get(entry.id);
      if (!found) return [];
      const count = found.streams ? null : found.channels.size;
      return [{ subscriptionId: entry.id, label, why: found.why, count }];
    }),
  };
}

/** The favourites as they stand, drawn again as the record, the channels or a provider changes. */
export function useFavourites(): FavouriteList | null {
  const viewing = useViewing();
  const catalogue = useCatalogue();
  const roster = useRoster();
  return useMemo(
    () => favouriteList(viewing, catalogue, roster.kind === "ready" ? roster.members : []),
    [viewing, catalogue, roster],
  );
}

/**
 * The keys of the channels that are favourites, as Live's rows and Watch's star read them. A
 * channel of a provider that needs its password is still one: its star takes it out.
 */
export function useFavouriteKeys(): ReadonlySet<string> {
  const viewing = useViewing();
  const catalogue = useCatalogue();
  return useMemo(() => {
    const library = catalogue.kind === "ready" ? catalogue.library : null;
    return new Set(
      (viewing?.favourites ?? []).flatMap((saved) => {
        const channel = library?.byKey.get(ownedKey(saved));
        return channel ? [channel.key] : [];
      }),
    );
  }, [viewing, catalogue]);
}

/** Stars or unstars `channel`, playing nothing; says so when viewing.json won't take it. */
export function starChannel(channel: Channel, favourite: boolean) {
  setFavourite(channel, favourite).catch((cause: unknown) =>
    Alert.alert(
      favourite ? `Couldn't add ${channel.title}` : `Couldn't remove ${channel.title}`,
      describeError(appError(cause)),
      [
        { text: "Cancel", style: "cancel" },
        { text: "Try again", onPress: () => starChannel(channel, favourite) },
      ],
    ),
  );
}
