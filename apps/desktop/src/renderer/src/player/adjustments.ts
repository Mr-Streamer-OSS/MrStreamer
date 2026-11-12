// Picture and sound adjustments: the viewer's sound delay, leveling, aspect, crop and zoom for
// everything that plays on this computer. They are kept in the viewing preferences and apply at
// once to what plays, live channels, titles and downloads alike; sound.ts applies the sound part
// to the media elements the engines play in, and an adjusted <Picture> the picture part.
//
// The query cache owns what is saved. This holds what plays: the latest choice, while it is saved,
// and the saved one otherwise. A choice that can't be saved goes back to the saved one and stays
// as `failed`, to say so and to try again.
//
// A receiver on the network plays the stream as sent: none of this reaches it, and
// `useAdjustmentsRefusal` says so while one has playback.
import type { QueryClient } from "@tanstack/react-query";
import { createStore, useStore } from "zustand";
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  type PlaybackAdjustments,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import { t } from "@mrstreamer/core/i18n";
import { appError, describeError } from "../lib/errors.ts";
import { currentPreferences, readPreferences, updatePreferences } from "../lib/preferences.ts";
import { receiverName, useOutput } from "./output.ts";
import { setSound } from "./sound.ts";

export interface AdjustmentsState {
  /** What plays now: the latest choice while it is saved, the saved one otherwise. */
  readonly adjustments: PlaybackAdjustments;
  /** A choice is on its way to the viewing preferences. */
  readonly saving: boolean;
  /**
   * The last choice that could not be saved and what went wrong, translated. Playback went back to
   * the saved adjustments. Null once another choice is made.
   */
  readonly failed: { readonly adjustments: PlaybackAdjustments; readonly message: string } | null;
}

const store = createStore<AdjustmentsState>(() => ({
  adjustments: DEFAULT_PLAYBACK_ADJUSTMENTS,
  saving: false,
  failed: null,
}));

/** The choice on its way to the file; only its own answer may settle it. */
let pending: PlaybackAdjustments | null = null;

function play(adjustments: PlaybackAdjustments): void {
  store.setState({ adjustments });
  setSound(adjustments);
}

function saved(preferences: Preferences | undefined): PlaybackAdjustments {
  return preferences?.playbackAdjustments ?? DEFAULT_PLAYBACK_ADJUSTMENTS;
}

/** Reads the adjustments in a component. */
export function usePlaybackAdjustments<T>(selector: (state: AdjustmentsState) => T): T {
  return useStore(store, selector);
}

/** Composition applies saved adjustments, unless a newer choice awaits its answer. */
export function hydratePlaybackAdjustments(preferences: Preferences): void {
  if (!pending) play(saved(preferences));
}

/**
 * Changes some adjustments, which play at once and are saved. Resolves when that is settled;
 * a failure shows as `failed` rather than rejecting.
 */
export async function adjustPlayback(
  change: Partial<PlaybackAdjustments>,
  client?: QueryClient,
): Promise<void> {
  const next = { ...store.getState().adjustments, ...change };
  pending = next;
  store.setState({ saving: true, failed: null });
  play(next);

  try {
    const preferences = await updatePreferences({ playbackAdjustments: next }, client);

    if (pending !== next) return;
    pending = null;
    store.setState({ saving: false });
    play(saved(preferences));
  } catch (cause) {
    if (pending !== next) return;
    // A write can fail after it reached the file; take what is saved now, if it can be read.
    await readPreferences(client).catch(() => {});

    if (pending !== next) return;
    pending = null;
    store.setState({
      saving: false,
      failed: { adjustments: next, message: describeError(appError(cause)) },
    });
    play(saved(currentPreferences(client)));
  }
}

/** Whether anything differs from the stream's own timing, loudness and picture. */
export function isAdjusted(adjustments: PlaybackAdjustments): boolean {
  return (Object.keys(DEFAULT_PLAYBACK_ADJUSTMENTS) as (keyof PlaybackAdjustments)[]).some(
    (key) => adjustments[key] !== DEFAULT_PLAYBACK_ADJUSTMENTS[key],
  );
}

/** Back to the stream's own timing, loudness and picture. */
export function resetPlayback(client?: QueryClient): Promise<void> {
  return adjustPlayback(DEFAULT_PLAYBACK_ADJUSTMENTS, client);
}

/** Tries the choice that could not be saved again; nothing while none failed. */
export async function retryPlayback(client?: QueryClient): Promise<void> {
  const { failed } = store.getState();

  if (failed) await adjustPlayback(failed.adjustments, client);
}

/**
 * Why the adjustments don't apply to what plays now, "Living Room TV plays the stream as sent",
 * or null while playback is this computer's.
 *
 * @public For the player's picture and sound controls, which say it in place of their choices.
 */
export function useAdjustmentsRefusal(): string | null {
  const output = useOutput((state) => state.status.output);

  if (output.kind !== "receiver" && output.kind !== "lost") return null;

  return t("{receiver} plays the stream as sent", { receiver: receiverName(output.receiver) });
}
