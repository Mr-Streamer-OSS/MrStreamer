// Where playback goes, as the UI knows it: this computer, or a receiver on the network. The main
// process owns the receiver and what it plays (see main/services/output.ts) and says what it
// last confirmed; this keeps that for the views, and passes on what the viewer chooses.
//
// The two player controllers follow it: with a receiver connected, what they are asked to play
// goes there and their state is the receiver's. Nothing here plays or stops anything by itself.
import { createStore, useStore } from "zustand";
import type { OutputStatus, Receiver, RemoteMedia } from "@mrstreamer/contracts/output";
import { call, listen } from "../lib/ipc.ts";

/** A place in the window, in CSS pixels, for the system's list of receivers to open from. */
export interface Anchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface OutputState {
  readonly status: OutputStatus;
  /** When the connect under way began, as `Date.now()`; null while none is. */
  readonly connectingSince: number | null;
  /** The app's own list of receivers shows. */
  readonly choosing: boolean;
}

const LOCAL: OutputStatus = {
  offers: [],
  airplayRoutes: null,
  scanning: false,
  receivers: [],
  output: { kind: "local" },
};

const store = createStore<OutputState>(() => ({
  status: LOCAL,
  connectingSince: null,
  choosing: false,
}));

/** Reads where playback goes in a component. */
export function useOutput<T>(selector: (state: OutputState) => T): T {
  return useStore(store, selector);
}

const listeners = new Set<(now: OutputStatus, before: OutputStatus) => void>();
/** Where the system's list last opened from, for opening it again after a lost connection. */
let anchor: Anchor = { x: 0, y: 0, width: 0, height: 0 };

function take(status: OutputStatus): void {
  const before = store.getState().status;
  const connecting = status.output.kind === "connecting";
  store.setState((state) => ({
    status,
    connectingSince: connecting ? (state.connectingSince ?? Date.now()) : null,
  }));
  for (const listener of listeners) listener(status, before);
}

listen("output.changed", take);
void call("output.status")
  .then(take)
  .catch(() => {});

/** "Living Room TV", or "AirPlay" for a receiver the system doesn't name. */
export function receiverName(receiver: Pick<Receiver, "kind" | "name"> | null): string {
  return receiver?.name ?? (receiver?.kind === "cast" ? "the TV" : "AirPlay");
}

/** "on Living Room TV", or "over AirPlay" for a receiver the system doesn't name. */
export function where(receiver: Pick<Receiver, "kind" | "name"> | null): string {
  return receiver?.name
    ? `on ${receiver.name}`
    : receiver?.kind === "cast"
      ? "on the TV"
      : "over AirPlay";
}

/**
 * Why a page's preview stands still, "Preview waits while Living Room TV plays", or null while
 * playback is this computer's and it runs.
 */
export function usePreviewWaits(): string | null {
  const output = useOutput((state) => state.status.output);
  if (output.kind !== "receiver" && output.kind !== "lost") return null;
  const busy = output.kind === "receiver" && output.media !== null;
  return `Preview waits while ${receiverName(output.receiver)} ${busy ? "plays" : "is connected"}`;
}

/** Where `media` is now, in seconds into its title: the receiver's last word, moved on while it plays. */
export function positionOf(media: RemoteMedia, now = Date.now()): number {
  const moved = media.state === "playing" ? Math.max(0, (now - media.at) / 1000) : 0;
  return Math.min(media.position + moved, media.duration ?? Infinity);
}

export const outputs = {
  status: (): OutputStatus => store.getState().status,
  /** The receiver that has playback, or had it until its connection broke; null when it plays here. */
  receiver(): Receiver | null {
    const { output } = store.getState().status;
    return output.kind === "receiver" || output.kind === "lost" ? output.receiver : null;
  },
  /** Whether a receiver takes what is played now. */
  remote: (): boolean => store.getState().status.output.kind === "receiver",
  /** What the receiver plays, as it last confirmed; null when it plays nothing. */
  media(): RemoteMedia | null {
    const { output } = store.getState().status;
    return output.kind === "receiver" ? output.media : null;
  },
  /** Hears every change, with what was before. Returns the unsubscribe function. */
  subscribe(listener: (now: OutputStatus, before: OutputStatus) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /**
   * Opens the chooser: the app's own list where it finds receivers itself, and the system's
   * list at `from`, a place in the window, where only that knows them.
   */
  choose(from: Anchor): void {
    anchor = from;
    const { offers } = store.getState().status;
    if (offers.length === 0) return;
    if (offers.every((kind) => kind === "airplay")) void outputs.pick();
    else outputs.list(true);
  },
  /** Shows or hides the app's own list, which looks for receivers while it shows. */
  list(open: boolean): void {
    if (store.getState().choosing === open) return;
    store.setState({ choosing: open });
    void call("output.scan", { on: open }).catch(() => {});
  },
  /** Connects to a receiver the list shows. What plays here goes on until it answers. */
  connect(receiverId: string): void {
    void call("output.connect", { receiverId }).catch(() => {});
  },
  /** Opens the system's list at `from`, or where the chooser last opened. */
  pick(from: Anchor = anchor): void {
    anchor = from;
    void call("output.pick", { anchor }).catch(() => {});
  },
  /** Connects again to the receiver whose connection broke. */
  reconnect(): void {
    const receiver = outputs.receiver();
    if (!receiver) return;
    if (receiver.kind === "airplay") outputs.pick();
    else outputs.connect(receiver.id);
  },
  /** Back to this computer, also from a connect under way. Resolves once the receiver is let go of. */
  local: (): Promise<void> =>
    call("output.disconnect")
      .then(() => {})
      .catch(() => {}),
  /** Ends what the receiver plays, whichever view started it, and keeps the receiver. */
  stop(): void {
    const media = outputs.media();
    if (!media) return;
    void call("output.command", { generation: media.generation, command: "stop" }).catch(() => {});
  },
  /** Sets the receiver's volume, where it can be set from here. */
  volume(volume: { level?: number; muted?: boolean }): void {
    void call("output.volume", volume).catch(() => {});
  },
};
