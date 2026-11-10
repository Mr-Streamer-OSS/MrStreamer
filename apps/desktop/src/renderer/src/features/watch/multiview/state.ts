// What the multiview's bar, grid and transport share: the four slots, the slots a saved layout
// couldn't fill, the count-only stream meter's read and how a refused or failed pane change is said.
import { queryOptions } from "@tanstack/react-query";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LiveTimeline, PaneRefusal } from "@mrstreamer/contracts/playback";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { create } from "zustand";
import { appError, describeError } from "../../../lib/errors.ts";
import { callForProfile, profileOwner } from "../../../lib/ipc.ts";
import { clock } from "../../../lib/titles.ts";
import { LIVE_EDGE_MS, paneGroup, PaneRefused, type PaneId } from "../../../player/player.ts";
import { flash } from "../flash-state.ts";

/** The fixed slots, in reading order: two rows of two. A saved layout fills them from the first. */
export const SLOTS = ["1", "2", "3", "4"] as const satisfies readonly PaneId[];

/** Menus and popovers of the multiview. Watch's key handler leaves keys to them while one is open. */
const multiviewMenus = ["layouts", "save-layout", "add"] as const;

export type MultiviewMenu = (typeof multiviewMenus)[number];

export function isMultiviewMenu(menu: unknown): menu is MultiviewMenu {
  return multiviewMenus.some((each) => each === menu);
}

/**
 * Slots whose saved channel the viewer can no longer open: gone from the provider, or hidden by
 * their profile. They show as unavailable without the channel's name until filled again.
 */
export const useVanished = create<{ readonly slots: readonly PaneId[] }>(() => ({ slots: [] }));

/**
 * The selected channel's account: whether it allows several streams and how many are in use now.
 * Informational only: main decides each admission, and nothing here reserves a stream. A changed
 * `panes` key, such as the panes' channels and phases, reads it again.
 */
export const capacityQuery = (channel: LiveChannel | null, panes = "") => {
  const owner = profileOwner();

  return queryOptions({
    queryKey: ["playback", "paneCapacity", owner, channel ? ownedKey(channel) : null, panes],
    queryFn: () => callForProfile(owner, "playback.paneCapacity", { channel: ownedId(channel!) }),
    enabled: channel !== null,
    refetchInterval: 5000,
  });
};

/** A refused pane in a title and, where one helps, a sentence. `provider` names the account. */
export function refusalCopy(
  reason: PaneRefusal["reason"],
  provider: string,
): { readonly title: string; readonly body: string | null } {
  if (reason === "capacity")
    return {
      title: t("No stream free"),
      body: t("All {provider} streams are in use", { provider }),
    };

  if (reason === "ineligible")
    return { title: t("Unavailable"), body: t("Only subscriptions that allow several streams") };

  return { title: t("Unavailable"), body: null };
}

/**
 * Says why a pane change didn't happen. Main's refusals are said by `refused`, which returns null
 * where nothing needs saying, such as a request a newer one replaced. Any other failure is said
 * as the error it was, so a failed read or write is never taken for a refusal.
 */
export function reportPaneFailure(
  cause: unknown,
  refused: (reason: PaneRefusal["reason"]) => string | null,
): void {
  if (cause instanceof PaneRefused) {
    const text = refused(cause.refusal.reason);

    if (text) flash(text);
  } else flash(describeError(appError(cause)));
}

/** Closes a pane, saying when it couldn't. A close a newer change replaced needs no words. */
export function closePane(id: PaneId, channel: { readonly title: string }): void {
  void paneGroup
    .close(id)
    .catch((cause: unknown) =>
      reportPaneFailure(cause, (reason) =>
        reason === "stale"
          ? null
          : t("Couldn't close {channel}. Try again.", { channel: channel.title }),
      ),
    );
}

/** "0:45 behind live" for a retained window rewound past the live edge, else null. */
export function behindLive(timeline: LiveTimeline | null): string | null {
  const behind = timeline ? timeline.end - timeline.cursor : 0;

  return behind >= LIVE_EDGE_MS ? t("{time} behind live", { time: clock(behind / 1000) }) : null;
}
