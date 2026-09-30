// The viewing record's rules: which events a command produces, and what the events add up to.
// Both are plain functions of their input. They never read the clock, fetch or make ids; the
// service supplies time and ids, and the store keeps the events and the state they add up to.
// How far movies and episodes got follows the rules in ./titles.ts, one row per title.
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
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
  /** A movie or episode played up to `position` of `duration` seconds. */
  | {
      readonly type: "title-progress";
      readonly title: TitleRef;
      readonly position: number;
      readonly duration: number;
    }
  /** Taken out of Continue watching: the movie, or the whole series of an episode. */
  | { readonly type: "title-removed"; readonly title: TitleRef };

export type ChannelEvent = Extract<ViewingEvent, { readonly channelId: string }>;
export type TitleEvent = Extract<ViewingEvent, { readonly title: TitleRef }>;

export type ViewingCommand =
  | { readonly kind: "set-favourite"; readonly channelId: string; readonly favourite: boolean }
  | { readonly kind: "record-watch"; readonly channelId: string }
  | {
      readonly kind: "record-progress";
      readonly title: TitleRef;
      readonly position: number;
      readonly duration: number;
    }
  | { readonly kind: "remove-title"; readonly title: TitleRef };

/** One account's favourites and recently watched channels. */
export interface ViewingState {
  /** In the order they were added. */
  readonly favourites: readonly string[];
  /** Most recent first, at most `RECENT_LIMIT`. */
  readonly recent: readonly string[];
}

export const emptyState: ViewingState = { favourites: [], recent: [] };

/** The events a command produces from `state`. Asking for what already holds produces none. */
export function decide(state: ViewingState, command: ViewingCommand): ViewingEvent[] {
  switch (command.kind) {
    case "set-favourite": {
      const is = state.favourites.includes(command.channelId);
      if (is === command.favourite) return [];
      return [
        {
          type: command.favourite ? "favourite-added" : "favourite-removed",
          channelId: command.channelId,
        },
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
        },
      ];
    case "remove-title":
      return [{ type: "title-removed", title: command.title }];
  }
}

/** Whether an event is about a movie or episode, rather than a channel. */
export function isTitleEvent(event: ViewingEvent): event is TitleEvent {
  return "title" in event;
}

/** The state after a channel event. Title events change title rows instead; see ./titles.ts. */
export function apply(state: ViewingState, event: ChannelEvent): ViewingState {
  switch (event.type) {
    case "favourite-added":
      return state.favourites.includes(event.channelId)
        ? state
        : { ...state, favourites: [...state.favourites, event.channelId] };
    case "favourite-removed":
      return { ...state, favourites: state.favourites.filter((id) => id !== event.channelId) };
    case "watched":
      return {
        ...state,
        recent: [event.channelId, ...state.recent.filter((id) => id !== event.channelId)].slice(
          0,
          RECENT_LIMIT,
        ),
      };
  }
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
