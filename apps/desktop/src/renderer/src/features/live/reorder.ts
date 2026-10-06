// Putting the favourites in another order, in Live TV's Favourites list: a draft of the channels
// shown there, which the viewer arranges with each row's buttons or the keys. Save sends it once;
// Cancel, and leaving the list, throw it away. Until it is saved, nothing but this draft knows it.
//   The draft belongs to the subscription and the favourites it was read from. It closes when
// they, or the channels the list shows, change under it, as a new catalogue or the setting for
// adults does. The main process checks the same as it saves, so an order from an older list
// never lands: it answers that the favourites changed, and the draft asks to be read again.
//   Up and Down move the selection; PageUp, PageDown, Home and End jump. With Alt, or Option on a
// Mac, the same keys move the selected channel: one place, ten, or to the top or bottom. Enter
// saves and Escape cancels.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { appError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { keepViewing, queries } from "../../lib/queries.ts";

/** What of a row holds the focus: the row itself, or one of its two buttons. */
export type RowPart = "row" | "up" | "down";

interface Draft {
  /** The subscription the favourites were read from: the order is saved to it alone. */
  readonly subscription: string;
  /** Every favourite as read, with those the list doesn't show. */
  readonly original: readonly string[];
  /** The channels the list showed, as read. */
  readonly listed: readonly LiveChannel[];
  /** The same channels as arranged. */
  readonly order: readonly LiveChannel[];
  /**
   * The channel the keys move, and the part of its row with the focus. `asked` counts the times
   * the viewer chose it, so a row chosen again takes the focus again.
   */
  readonly focus: { readonly id: string; readonly part: RowPart; readonly asked: number };
  /**
   * `saving` until the main process answers, and nothing moves meanwhile. `failed` keeps the
   * draft to send again. `changed` when the favourites are no longer the ones read: the draft
   * can't be saved, only read again, which `reading` waits for.
   */
  readonly status: "editing" | "saving" | "failed" | "changed" | "reading";
  /**
   * The id the order is sent under: again for a retry, another once the order changed. While
   * the favourites are read again, what names that read.
   */
  readonly commandId: string | null;
  /** What a screen reader hears of the last move: "Nature, 2 of 9". */
  readonly said: string;
}

interface OrderEditor {
  /** The order being made, or null while the list shows the saved one. */
  readonly draft: Draft | null;
  /** Whether there is an order to make: two channels or more, of a subscription that is known. */
  readonly available: boolean;
  /** Starts a draft from the list as it shows, with the keys on the channel `focusId`. */
  start(focusId: string | null): void;
  /** Gives a row the keys, as a click on it or the arrows do. */
  select(id: string, part?: RowPart): void;
  /** Notes where the focus went by itself, as with Tab, so a move keeps it there. */
  focused(id: string, part: RowPart): void;
  /** Moves the selection `by` rows, within the list. */
  step(by: number): void;
  /** Moves a channel `by` places, within the list, and gives it the keys. */
  move(id: string, by: number, part?: RowPart): void;
  /** Saves the draft, or sends it again after a failure; reads the favourites again once changed. */
  confirm(): void;
  /** Throws the draft away. Not while it waits for the main process. */
  cancel(): void;
}

/** How far each key goes. With Alt it moves the channel, without it the selection. */
const STEPS: Readonly<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  PageUp: -10,
  PageDown: 10,
  Home: -Infinity,
  End: Infinity,
};

/** Sends a key to the order being made. Every other key of the guide rests meanwhile. */
export function orderKey(event: KeyboardEvent, order: OrderEditor): void {
  const { draft } = order;
  if (!draft) return;
  const by = Object.hasOwn(STEPS, event.key) ? STEPS[event.key] : undefined;
  if (by !== undefined) {
    if (event.altKey) order.move(draft.focus.id, by);
    else order.step(by);
  } else if (event.key === "Enter") {
    // A button with the focus takes Enter itself, as it takes Space.
    if (event.target instanceof HTMLButtonElement || event.repeat) return;
    order.confirm();
  } else if (event.key === "Escape") order.cancel();
  else return;
  event.preventDefault();
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, at) => id === b[at]);

const idsOf = (channels: readonly LiveChannel[]) => channels.map((channel) => channel.id);

/** Whether a draft waits for the main process: nothing moves meanwhile, and nothing leaves it. */
export const waits = (draft: Draft | null): boolean =>
  draft?.status === "saving" || draft?.status === "reading";

/**
 * A draft of `channels` as they stand, with the keys on `focusId` or else the first; null when
 * there is nothing to order, one channel or none.
 */
function drafted(
  subscription: string,
  favourites: readonly string[],
  channels: readonly LiveChannel[],
  focusId: string | null,
  asked: number,
): Draft | null {
  const id = channels.find((channel) => channel.id === focusId)?.id ?? channels[0]?.id;
  if (channels.length < 2 || id === undefined) return null;
  return {
    subscription,
    original: favourites,
    listed: channels,
    order: channels,
    focus: { id, part: "row", asked },
    status: "editing",
    commandId: null,
    said: "",
  };
}

/**
 * The order of the favourites as the viewer makes it. `channels` are the favourites the list
 * shows, unsearched, or undefined while they load, and `open` says whether the list is there to
 * order: leaving it throws the draft away.
 */
export function useFavouriteOrder(
  open: boolean,
  channels: readonly LiveChannel[] | undefined,
): OrderEditor {
  const client = useQueryClient();
  const subscription = useQuery(queries.subscription()).data?.id ?? null;
  const favourites = useQuery(queries.viewing()).data?.favourites;
  const [draft, setDraft] = useState<Draft | null>(null);

  // A draft ends when the list is left, and when the favourites or the channels shown are no
  // longer the ones it was made from: an order of an older list is no order of this one. One
  // that waits for the main process stays for its answer, and one it refused to be read again.
  const obsolete =
    draft !== null &&
    (!open ||
      ((draft.status === "editing" || draft.status === "failed") &&
        (!favourites ||
          !channels ||
          !sameIds(favourites, draft.original) ||
          !sameIds(idsOf(channels), idsOf(draft.listed)))));
  useEffect(() => {
    if (obsolete) setDraft(null);
  }, [obsolete]);

  // While a draft waits for the main process nothing else happens to it, and nothing takes the
  // viewer away from it before the answer: the keys rest, for every listener of the window.
  const waiting = waits(draft);
  useEffect(() => {
    if (!waiting) return;
    const rest = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    window.addEventListener("keydown", rest, true);
    return () => window.removeEventListener("keydown", rest, true);
  }, [waiting]);

  const available =
    subscription !== null && favourites !== undefined && (channels?.length ?? 0) > 1;

  /**
   * Changes the draft once an answer is in, if it still waits for that one: a draft cancelled or
   * started since stays as it is.
   */
  const answer = (token: string, next: (waiting: Draft) => Draft | null) =>
    setDraft((current) =>
      current && waits(current) && current.commandId === token ? next(current) : current,
    );

  const select = (id: string, part: RowPart = "row") => {
    if (!draft || waiting) return;
    setDraft({ ...draft, focus: { id, part, asked: draft.focus.asked + 1 } });
  };

  const save = (from: Draft) => {
    if (sameIds(idsOf(from.order), idsOf(from.listed))) return setDraft(null);
    const commandId = from.commandId ?? crypto.randomUUID();
    setDraft({ ...from, status: "saving", commandId });
    const { subscription, original, order } = from;
    void call("viewing.reorderFavourites", {
      commandId,
      subscription,
      original: [...original],
      order: idsOf(order),
    }).then(
      (viewing) => {
        // An answer for a subscription that has gone since tells the lists of the next nothing.
        if (client.getQueryData(queries.subscription().queryKey)?.id === subscription) {
          // The list in its new order, at hand before it shows: it never stands empty between.
          client.setQueryData(queries.channelsById(viewing.favourites).queryKey, order);
          keepViewing(client, viewing);
        }
        answer(commandId, () => null);
      },
      (cause: unknown) => {
        const changed = appError(cause).kind === "favourites-changed";
        answer(commandId, (sent) => ({ ...sent, status: changed ? "changed" : "failed" }));
      },
    );
  };

  /**
   * Starts over from the favourites as the main process has them, which refused the order: what
   * this page holds of them may be as old as the draft.
   */
  const reload = (from: Draft) => {
    const token = crypto.randomUUID();
    setDraft({ ...from, status: "reading", commandId: token });
    void (async () => {
      const viewing = await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
      const listed =
        viewing.favourites.length > 0
          ? await client.fetchQuery({ ...queries.channelsById(viewing.favourites), staleTime: 0 })
          : [];
      if (client.getQueryData(queries.subscription().queryKey)?.id !== from.subscription) {
        return null;
      }
      const { id, asked } = from.focus;
      return drafted(from.subscription, viewing.favourites, listed, id, asked + 1);
    })().then(
      (fresh) => answer(token, () => fresh),
      () => answer(token, () => null),
    );
  };

  return {
    draft,
    available,
    start: (focusId) => {
      if (available && channels) setDraft(drafted(subscription, favourites, channels, focusId, 1));
    },
    select,
    focused: (id, part) => {
      if (!draft || waiting) return;
      if (draft.focus.id === id && draft.focus.part === part) return;
      setDraft({ ...draft, focus: { ...draft.focus, id, part } });
    },
    step: (by) => {
      if (!draft) return;
      const at = draft.order.findIndex((channel) => channel.id === draft.focus.id);
      const next = draft.order[Math.min(Math.max(at + by, 0), draft.order.length - 1)];
      if (next) select(next.id);
    },
    move: (id, by, part = "row") => {
      if (!draft || (draft.status !== "editing" && draft.status !== "failed")) return;
      const from = draft.order.findIndex((channel) => channel.id === id);
      const channel = draft.order[from];
      if (!channel) return;
      const to = Math.min(Math.max(from + by, 0), draft.order.length - 1);
      const order = draft.order.toSpliced(from, 1).toSpliced(to, 0, channel);
      setDraft({
        ...draft,
        order,
        focus: { id, part, asked: draft.focus.asked + 1 },
        // Another order than the one that failed is another save, under an id of its own.
        ...(to === from ? {} : { status: "editing", commandId: null }),
        said: `${channel.title}, ${to + 1} of ${order.length}`,
      });
    },
    confirm: () => {
      if (!draft || waiting) return;
      if (draft.status === "changed") reload(draft);
      else save(draft);
    },
    cancel: () => {
      if (draft && !waiting) setDraft(null);
    },
  };
}
