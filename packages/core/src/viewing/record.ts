// The viewing record's rules: which events a command produces, and what the events add up to.
// Both are plain functions of their input. They never read the clock, fetch or make ids; the
// service supplies time and ids, and the store keeps the events and the state they add up to.
// How far movies and episodes got follows the rules in ./titles.ts, one row per title. Everything
// here is one account's, by the provider's own ids: the service says which subscription's.
import type { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { RECENT_LIMIT } from "@mrstreamer/contracts/viewing";

/** The version events are written with. Readers skip events from a newer version. */
export const EVENT_VERSION = 1;
/** Rises when `apply` or the rules in ./titles.ts change, so stored state is rebuilt from the events. */
export const STATE_VERSION = 1;

/**
 * What happened, by meaning: not which button was pressed. Builds from before movies and series
 * skip the title events, as they skip any type they don't know.
 */
export type ViewingEvent =
  | { readonly type: "favourite-added"; readonly channelId: string }
  | { readonly type: "favourite-removed"; readonly channelId: string }
  | { readonly type: "watched"; readonly channelId: string }
  /**
   * A movie or episode played up to `position` of `duration` seconds, in a play that began at
   * `since`, epoch milliseconds. Builds before `since` wrote none: theirs read as a play begun when
   * the event was saved.
   */
  | {
      readonly type: "title-progress";
      readonly title: RawTitleRef;
      readonly position: number;
      readonly duration: number;
      readonly since: number;
    }
  /** Taken out of Continue watching: the movie, or the whole series of an episode. */
  | { readonly type: "title-removed"; readonly title: RawTitleRef }
  /**
   * The series of `title`, its last episode, watched to the end of what the provider lists. It
   * leaves Continue watching as a removal does.
   */
  | { readonly type: "series-finished"; readonly title: RawTitleRef };

export type ChannelEvent = Extract<ViewingEvent, { readonly channelId: string }>;
export type TitleEvent = Extract<ViewingEvent, { readonly title: RawTitleRef }>;

export type ViewingCommand =
  | {
      readonly kind: "set-favourite";
      /**
       * The channel's own id and its streams': any of them among the favourites makes it one.
       * Adding keeps them all, so the channel stays a favourite while any of its streams is listed.
       */
      readonly channelIds: readonly string[];
      readonly favourite: boolean;
    }
  /** The favourites in another order: `favourites` holds the stored ids, each once, and no other. */
  | { readonly kind: "reorder-favourites"; readonly favourites: readonly string[] }
  | { readonly kind: "record-watch"; readonly channelId: string }
  | {
      readonly kind: "record-progress";
      readonly title: RawTitleRef;
      readonly position: number;
      readonly duration: number;
      readonly since: number;
    }
  /** Movies, and episodes standing for their series, out of Continue watching at once. */
  | { readonly kind: "remove-titles"; readonly titles: readonly RawTitleRef[] }
  /** An episode standing for each version of a series played, whose last episode was watched. */
  | { readonly kind: "finish-series"; readonly titles: readonly RawTitleRef[] };

/**
 * One account's favourites and recently watched channels, by the provider's stream ids: one or
 * more per channel. The service shows them by channel (see ./service.ts).
 */
export interface ViewingState {
  /** In the order they were added, or the order the viewer gave them since. */
  readonly favourites: readonly string[];
  /** Most recent first, at most `RECENT_LIMIT`. */
  readonly recent: readonly string[];
}

export const emptyState: ViewingState = { favourites: [], recent: [] };

/** The events a command produces from `state`. Asking for what already holds produces none. */
export function decide(state: ViewingState, command: ViewingCommand): ViewingEvent[] {
  switch (command.kind) {
    case "set-favourite": {
      const listed = state.favourites.filter((id) => command.channelIds.includes(id));
      if (!command.favourite) {
        return listed.map((channelId) => ({ type: "favourite-removed", channelId }));
      }
      if (listed.length > 0) return [];
      return command.channelIds.map((channelId) => ({ type: "favourite-added", channelId }));
    }
    case "reorder-favourites": {
      // A favourite moves only by leaving and coming back, and comes back last. So the start of
      // the new order that the stored one already holds, in that order, stays where it is, and
      // the rest leaves and comes back in the order wanted.
      let kept = 0;
      for (const id of state.favourites) if (id === command.favourites[kept]) kept++;
      const moved = command.favourites.slice(kept);
      return [
        ...moved.map((channelId): ViewingEvent => ({ type: "favourite-removed", channelId })),
        ...moved.map((channelId): ViewingEvent => ({ type: "favourite-added", channelId })),
      ];
    }
    case "record-watch":
      return [{ type: "watched", channelId: command.channelId }];
    case "record-progress":
      return [
        {
          type: "title-progress",
          title: command.title,
          position: command.position,
          duration: command.duration,
          since: command.since,
        },
      ];
    case "remove-titles":
      return command.titles.map((title) => ({ type: "title-removed", title }));
    case "finish-series":
      return command.titles.map((title) => ({ type: "series-finished", title }));
  }
}

/** Whether an event is about a movie or episode, rather than a channel. */
export function isTitleEvent(event: ViewingEvent): event is TitleEvent {
  return "title" in event;
}

/**
 * The state after channel events, in their order. Title events change title rows instead; see
 * ./titles.ts. It takes the favourites and the events once each, however many there are: a new
 * order of a long list removes and adds most of it.
 */
export function apply(state: ViewingState, events: readonly ChannelEvent[]): ViewingState {
  // A set keeps its ids in the order added, and adding one it holds changes nothing.
  const favourites = new Set(state.favourites);
  let recent = state.recent;
  for (const event of events) {
    switch (event.type) {
      case "favourite-added":
        favourites.add(event.channelId);
        break;
      case "favourite-removed":
        favourites.delete(event.channelId);
        break;
      case "watched":
        recent = [event.channelId, ...recent.filter((id) => id !== event.channelId)].slice(
          0,
          RECENT_LIMIT,
        );
    }
  }
  return { favourites: [...favourites], recent };
}

/**
 * The events that bring lists from before the record into it: favourites in their order, then
 * recent channels oldest first, so the most recent ends up first.
 */
export function importEvents(lists: {
  readonly favourites: readonly string[];
  readonly recent: readonly string[];
}): ViewingEvent[] {
  return [
    ...lists.favourites.map((channelId): ViewingEvent => ({ type: "favourite-added", channelId })),
    ...lists.recent.toReversed().map((channelId): ViewingEvent => ({ type: "watched", channelId })),
  ];
}
