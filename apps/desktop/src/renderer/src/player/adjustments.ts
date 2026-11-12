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
import { readPreferences, updatePreferences } from "../lib/preferences.ts";
import { profileOwner, currentProfile } from "../lib/ipc.ts";
import { receiverName, receiverOf, useOutput } from "./output.ts";
import { setSound } from "./sound.ts";

export interface AdjustmentsState {
  /** What plays now: the latest choice while it is saved, the saved one otherwise. */
  readonly adjustments: PlaybackAdjustments;
  /**
   * The last choice that could not be saved and what went wrong, translated. Playback went back to
   * the saved adjustments. Null once another choice is made.
   */
  readonly failed: {
    readonly kind: "save" | "sound";
    readonly adjustments: PlaybackAdjustments;
    readonly message: string;
  } | null;
}

const store = createStore<AdjustmentsState>(() => ({
  adjustments: DEFAULT_PLAYBACK_ADJUSTMENTS,
  failed: null,
}));

/** The choice on its way to the file; only its own answer may settle it. */
let pending: PlaybackAdjustments | null = null;
let owner = profileOwner();

function play(adjustments: PlaybackAdjustments): Promise<void> {
  store.setState({ adjustments });

  return setSound(adjustments);
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
  if (!currentProfile(owner)) {
    owner = profileOwner();
    pending = null;
    store.setState({ failed: null });
  }

  const captured = profileOwner();

  if (!pending)
    void play(saved(preferences)).catch((cause: unknown) => {
      if (!currentProfile(captured) || pending) return;
      store.setState({
        failed: {
          kind: "sound",
          adjustments: saved(preferences),
          message: describeError(appError(cause)),
        },
      });
    });
}

/**
 * Changes some adjustments, which play at once and are saved. Resolves when that is settled;
 * a failure shows as `failed` rather than rejecting.
 */
export async function adjustPlayback(
  change: Partial<PlaybackAdjustments>,
  client?: QueryClient,
): Promise<void> {
  const captured = profileOwner();
  const previous = store.getState().adjustments;
  const next = { ...previous, ...change };
  owner = captured;
  pending = next;
  store.setState({ failed: null });

  let saving = false;

  try {
    await play(next);
    saving = true;
    const preferences = await updatePreferences({ playbackAdjustments: next }, client, captured);

    if (pending !== next || !currentProfile(captured)) return;
    await play(saved(preferences));

    if (pending === next && currentProfile(captured)) pending = null;
  } catch (cause) {
    if (pending !== next || !currentProfile(captured)) return;
    // A write can fail after it reached the file; take what is saved now, if it can be read.
    const readback = await readPreferences(client).catch(() => undefined);

    if (pending !== next || !currentProfile(captured)) return;
    pending = null;
    const restored = readback ? saved(readback) : previous;

    const landed =
      restored.soundDelayMs === next.soundDelayMs &&
      restored.leveling === next.leveling &&
      restored.aspect === next.aspect &&
      restored.crop === next.crop &&
      restored.zoom === next.zoom;

    store.setState({
      failed:
        landed && saving
          ? null
          : {
              kind: saving ? "save" : "sound",
              adjustments: next,
              message: describeError(appError(cause)),
            },
    });
    await play(restored).catch((cause: unknown) => {
      store.setState({
        failed: { kind: "sound", adjustments: next, message: describeError(appError(cause)) },
      });
    });
  }
}

/** Back to the stream's own timing, loudness and picture. */
export function resetPlayback(client?: QueryClient): Promise<void> {
  return adjustPlayback(DEFAULT_PLAYBACK_ADJUSTMENTS, client);
}

/** Tries the choice that could not be saved again; nothing while none failed. */
export async function retryPlayback(client?: QueryClient): Promise<void> {
  const { failed } = store.getState();

  if (failed && currentProfile(owner)) await adjustPlayback(failed.adjustments, client);
}

/**
 * Why the adjustments don't apply to what plays now, "Living Room TV plays the stream as sent",
 * or null while playback is this computer's.
 */
export function useAdjustmentsRefusal(): string | null {
  const receiver = useOutput((state) => receiverOf(state.status.output));

  return receiver && t("{receiver} plays the stream as sent", { receiver: receiverName(receiver) });
}

// Lifecycle resume failures have no pending preference command, but must remain visible/retryable.
window.addEventListener("sounderror", (event) => {
  if (!(event instanceof CustomEvent)) return;
  store.setState({
    failed: {
      kind: "sound",
      adjustments: store.getState().adjustments,
      message: describeError(appError(event.detail)),
    },
  });
});
