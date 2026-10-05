// Where playback goes, as the UI knows it: this computer, or a receiver on the network. The main
// process owns the receiver and what it plays (see main/services/output.ts) and says what it
// last confirmed; this keeps that for the views, and passes on what the viewer chooses.
//
// The two player controllers follow it: with a receiver connected, what they are asked to play
// goes there and their state is the receiver's. Nothing here plays or stops anything by itself.
import { createStore, useStore } from "zustand";
import type {
  Output,
  OutputFailure,
  OutputStatus,
  Receiver,
  RemoteMedia,
} from "@mrstreamer/contracts/output";
import { appError } from "../lib/errors.ts";
import { call, listen } from "../lib/ipc.ts";

interface OutputState {
  readonly status: OutputStatus;
  /** When the connect under way began, as `Date.now()`; null while none is. */
  readonly connectingSince: number | null;
  /**
   * The receiver that had playback, or lost it, when the connect under way began; null while none
   * is, and for one that began from this computer.
   */
  readonly connectingFrom: Receiver | null;
  /** The app's own list of receivers shows. */
  readonly choosing: boolean;
  /** Why the last connect reached no receiver, and when; null once another began. */
  readonly refused: {
    readonly receiver: Pick<Receiver, "id" | "kind" | "name">;
    readonly failure: OutputFailure;
    readonly at: number;
  } | null;
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
  connectingFrom: null,
  choosing: false,
  refused: null,
}));

/** Reads where playback goes in a component. */
export function useOutput<T>(selector: (state: OutputState) => T): T {
  return useStore(store, selector);
}

const listeners = new Set<(now: OutputStatus, before: OutputStatus) => void>();

/**
 * The views on screen that show an output button, Watch and a playing title, each as the signal
 * that ends with it, in the order they opened. The system's list belongs to the one opened last
 * when it is asked for.
 */
const views = new Set<AbortSignal>();

/**
 * Where the system's list of receivers opens from, a place in the window in CSS pixels: the
 * output button where the view shows one, else the middle of the window. Measured for each list
 * and never remembered, since the window and its layout may have changed since the last one.
 */
function listAnchor() {
  const box = document.querySelector("[data-output]")?.getBoundingClientRect();
  return box
    ? { x: box.x, y: box.y, width: box.width, height: box.height }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0 };
}

/** The receiver `output` has playback on, or had it on until its connection broke. */
function receiverOf(output: Output): Receiver | null {
  return output.kind === "receiver" || output.kind === "lost" ? output.receiver : null;
}

function take(status: OutputStatus): void {
  const before = store.getState().status;
  const connecting = status.output.kind === "connecting";
  store.setState((state) => ({
    status,
    connectingSince: connecting ? (state.connectingSince ?? Date.now()) : null,
    connectingFrom: connecting ? (state.connectingFrom ?? receiverOf(before.output)) : null,
  }));
  for (const listener of listeners) listener(status, before);
}

listen("output.changed", take);
void call("output.status")
  .then(take)
  .catch(() => {});

/** Keeps why a connect to `receiver` reached nothing, for the views to say. */
function refused(receiver: Pick<Receiver, "id" | "kind" | "name">) {
  return (cause: unknown) => {
    const error = appError(cause);
    if (error.kind !== "output") return;
    store.setState({ refused: { receiver, failure: error.failure, at: Date.now() } });
  };
}

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
  receiver: (): Receiver | null => receiverOf(store.getState().status.output),
  /**
   * The receiver a failure there is said of: the one that has playback or lost it, and that one
   * still while it is reached again, or another in its place. Null when none had playback.
   */
  failedOn: (): Receiver | null => outputs.receiver() ?? store.getState().connectingFrom,
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
   * list where only that knows them.
   */
  choose(): void {
    const { offers } = store.getState().status;
    if (offers.length === 0) return;
    if (offers.every((kind) => kind === "airplay")) outputs.pick();
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
    const receiver = store.getState().status.receivers.find((each) => each.id === receiverId);
    store.setState({ refused: null });
    void call("output.connect", { receiverId }).catch(
      refused(receiver ?? { id: receiverId, kind: "cast", name: null }),
    );
  },
  /**
   * Says a view that shows an output button is on screen until `view` ends. The system's list
   * asked for meanwhile is that view's, whatever asked for it there.
   */
  viewShown(view: AbortSignal): void {
    views.add(view);
    view.addEventListener("abort", () => views.delete(view), { once: true });
  },
  /**
   * Opens the system's list at the output button, as the view shows it now. The list is that
   * view's and goes with it, open or still to open, while what plays stays as it is. On a page,
   * where no view shows the button, the list is the window's alone.
   */
  pick(): void {
    store.setState({ refused: null });
    const view = [...views].at(-1);
    // A name of its own for each list, so the main process takes down this one and none asked
    // for since.
    const request = crypto.randomUUID();
    const close = () => void call("output.closePicker", { request }).catch(() => {});
    view?.addEventListener("abort", close, { once: true });
    void call("output.pick", { anchor: listAnchor(), request })
      .catch(refused({ id: "airplay", kind: "airplay", name: null }))
      // Answered: the viewer is done at this list, and nothing of it is left to take down.
      .finally(() => view?.removeEventListener("abort", close));
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
