// AirPlay, on macOS. Electron can't AirPlay a stream, so a small helper program does: an AVPlayer
// that plays the address the output service hands over on the receiver the viewer picks in the
// system's own list (apps/desktop/native/airplay). This adapter starts the helper on first use,
// speaks to it in JSON lines (./protocol), and owns its lifetime (./helper).
//
// The system never names the receiver. All the helper can say is whether its player plays on one,
// AVPlayer's external playback, and only that counts as connected. So a connect shows the list
// and waits: for external playback to come on, or for the list to close and a moment to pass with
// nothing chosen. Once it goes off and stays off, the receiver let go.
//
// None of this has been tried against a receiver yet. What that leaves open is marked below.
import type { Receiver } from "@mrstreamer/contracts/output";
import type { Codec } from "@mrstreamer/contracts/playback";
import { withoutAddresses } from "@mrstreamer/core/provider";
import {
  ReceiverFailed,
  type AdapterEvent,
  type Connection,
  type ReceiverAdapter,
} from "../adapter.ts";
import { startHelper, unavailable, type HelperEnd, type HelperRun } from "./helper.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";

/** How long the adapter waits at each step, in milliseconds. */
export interface AirplayTimings {
  /**
   * For the helper to start and say hello, and to answer a command; then it is killed. Starting
   * may take seconds the first time, while the system checks a program it hasn't run before.
   */
  readonly start: number;
  readonly answer: number;
  /**
   * After the system's list closed, for the receiver the viewer picked there to start playing.
   * Nothing says a receiver was picked, so after this long nothing was. Unmeasured on a receiver.
   */
  readonly chosen: number;
  /** For the viewer to press the picker's own button, where the list didn't open by itself. */
  readonly button: number;
  /**
   * How long external playback may be off before the receiver counts as gone: it may drop for a
   * moment between two loads or two receivers. Unmeasured on a receiver.
   */
  readonly settle: number;
  /** For the helper to exit once asked. Then it is killed. */
  readonly quit: number;
  /** A helper that ran this long and then stops counts as a first stop, not one more in a row. */
  readonly steady: number;
}

const AIRPLAY_TIMINGS: AirplayTimings = {
  start: 15_000,
  answer: 5000,
  chosen: 5000,
  button: 30_000,
  settle: 2000,
  quit: 1000,
  steady: 30_000,
};

/** How often in a row a helper that stopped by itself is started again. */
const RESTARTS = 3;

/** The system keeps the receiver's name to itself. */
const RECEIVER: Receiver = { id: "airplay", kind: "airplay", name: null };

/**
 * What is sent as it is; everything else converts. A first profile that every AirPlay video
 * receiver should play, not what a particular one was seen to play: unproven on hardware.
 */
const DECODERS: readonly Codec[] = ["h264", "aac"];

export interface AirplayOptions {
  /** The helper's executable, or null where the app has none: off macOS, or a build without it. */
  readonly helper: string | null;
  /** What to start it with. The app passes nothing; tests run a stand-in with Node. */
  readonly args?: readonly string[];
  /** How long the adapter waits at each step, where a test wants it shorter. */
  readonly timings?: Partial<AirplayTimings>;
  /**
   * Takes every line exchanged with the helper, with addresses cut to their origin. The helper
   * says what it sees and when, which is the record of a try on a real receiver.
   */
  readonly log?: (line: string) => void;
}

/** One run of the helper, and what it last said of its player. */
interface Run {
  readonly helper: HelperRun;
  readonly since: number;
  /** Whether the player plays on a receiver. */
  external: boolean;
}

/** A connect that waits for the viewer at the system's list. */
interface Choosing {
  readonly request: number;
  readonly outcome: PromiseWithResolvers<Connection | null>;
  /**
   * External playback was off at some point since the list was asked for, so its coming on is
   * the viewer's pick. A list opened while a receiver plays waits for it to close instead.
   */
  fresh: boolean;
  closed: boolean;
  /** Runs out on the picker's button, or on the wait after the list closed. */
  timer: NodeJS.Timeout | undefined;
}

/** The connected receiver. */
interface Live {
  readonly connection: Connection;
  /** The load it was given last. */
  generation: number | null;
  /** That load failed: external playback ending after it is a connection that broke. */
  failed: boolean;
}

const unreachable = () => new ReceiverFailed({ kind: "unreachable" });

/** The AirPlay adapter. It starts nothing until it scans or connects. */
export function airplayAdapter(options: AirplayOptions): ReceiverAdapter {
  const timings = { ...AIRPLAY_TIMINGS, ...options.timings };
  let listener: (event: AdapterEvent) => void = () => {};
  let closed = false;
  /** Why no helper is started any more, once that is so. */
  let down = options.helper === null ? "this build has no AirPlay helper" : null;
  let scanning = false;
  /** What was last told about routes, so only a change is. */
  let routes: boolean | null = null;
  let volume: { readonly level: number; readonly muted: boolean } | null = null;
  let run: Run | null = null;
  /** Every helper not yet gone, those asked to quit included. */
  const running = new Set<HelperRun>();
  /** Stops in a row. */
  let stops = 0;
  let choosing: Choosing | null = null;
  let live: Live | null = null;
  let settling: NodeJS.Timeout | undefined;
  let requests = 0;

  const emit = (event: AdapterEvent) => {
    if (!closed) listener(event);
  };

  /** Sends to the helper that runs, if one does, and leaves a failure to its end. */
  const quiet = (command: HelperCommand) => {
    run?.helper.send(command).catch(() => {});
  };

  const tellRoutes = (available: boolean) => {
    if (routes === available) return;
    routes = available;
    emit({ type: "routes", available });
  };

  /** Ends the wait of a connect. Without a receiver the helper lets go of its placeholder too. */
  const settle = (mine: Choosing, outcome: Connection | ReceiverFailed | null) => {
    if (choosing !== mine) return;
    choosing = null;
    clearTimeout(mine.timer);
    quiet({ cmd: "hidePicker" });
    if (!live) quiet({ cmd: "unload" });
    if (outcome instanceof ReceiverFailed) mine.outcome.reject(outcome);
    else mine.outcome.resolve(outcome);
  };

  /** External playback stayed off: the receiver let go, or broke off after a load failed. */
  const released = () => {
    settling = undefined;
    const was = live;
    if (!was) return;
    live = null;
    quiet({ cmd: "unload" });
    emit(was.failed ? { type: "lost", failure: { kind: "unreachable" } } : { type: "released" });
  };

  /** The receiver external playback just came on at, as the connection the service drives. */
  const connected = (on: Run): Live => {
    /** While this is still the connection; a receiver that is gone takes nothing. */
    const send = (command: HelperCommand) =>
      live === mine ? on.helper.send(command) : Promise.reject(unreachable());
    /** For the load the receiver holds; one about an earlier load resolves and does nothing. */
    const about = (generation: number, command: HelperCommand) =>
      generation === mine.generation ? send(command) : Promise.resolve();
    const mine: Live = {
      generation: null,
      failed: false,
      connection: {
        receiver: RECEIVER,
        // The system doesn't say which of this computer's addresses the receiver reaches.
        localAddress: null,
        decoders: DECODERS,
        // AVPlayer's volume is the one documented control; what it does on a receiver is unverified.
        volume: true,
        async load(media, signal) {
          if (signal.aborted) throw unreachable();
          const { generation } = media;
          mine.generation = generation;
          mine.failed = false;
          const taken = send({
            cmd: "load",
            generation,
            url: media.url,
            position: media.live ? 0 : media.position,
            paused: media.paused,
            live: media.live,
            subtitles: media.subtitles,
          });
          // Given up from here: the helper may hold it by now, so it is told to stop it.
          const dropped = Promise.withResolvers<never>();
          const drop = () => {
            quiet({ cmd: "stop", generation });
            dropped.reject(unreachable());
          };
          signal.addEventListener("abort", drop, { once: true });
          try {
            await Promise.race([taken, dropped.promise]);
          } finally {
            signal.removeEventListener("abort", drop);
          }
        },
        play: (generation) => about(generation, { cmd: "play", generation }),
        pause: (generation) => about(generation, { cmd: "pause", generation }),
        seek: (generation, position) => about(generation, { cmd: "seek", generation, position }),
        showSubtitles: (generation, on) => about(generation, { cmd: "subtitles", generation, on }),
        setVolume: (to) => send({ cmd: "volume", ...to }),
        stop: (generation) => about(generation, { cmd: "stop", generation }),
        async disconnect() {
          if (live !== mine) return;
          if (choosing) settle(choosing, unreachable());
          live = null;
          clearTimeout(settling);
          settling = undefined;
          // No call takes a route back. The helper's process ending is what surely lets go of
          // the receiver; a new one starts when the adapter still scans.
          if (run === on) run = null;
          await on.helper.stop();
        },
      },
    };
    if (volume) emit({ type: "volume", ...volume });
    return mine;
  };

  /** Settles the connect that waits, once what the helper said decides it. */
  const judge = (on: Run) => {
    const mine = choosing;
    if (!mine) return;
    if (on.external && (mine.fresh || mine.closed)) {
      live ??= connected(on);
      settle(mine, live.connection);
    } else if (mine.closed) {
      mine.timer ??= setTimeout(() => settle(mine, null), timings.chosen);
    }
  };

  const heard = (on: Run, event: HelperEvent) => {
    switch (event.type) {
      case "routes":
        if (scanning) tellRoutes(event.available);
        return;
      case "picker": {
        const mine = choosing;
        if (!mine || event.request !== mine.request) return;
        clearTimeout(mine.timer);
        mine.timer = undefined;
        if (event.state === "manual") {
          mine.timer = setTimeout(() => settle(mine, null), timings.button);
        } else if (event.state === "closed") {
          mine.closed = true;
          judge(on);
        }
        return;
      }
      case "external":
        on.external = event.active;
        if (event.active) {
          clearTimeout(settling);
          settling = undefined;
        } else {
          if (choosing) choosing.fresh = true;
          if (live) settling ??= setTimeout(released, timings.settle);
        }
        judge(on);
        return;
      case "status":
        if (!live) return;
        // Under the generation the helper named: a late word on an earlier load stays that.
        emit({
          type: "status",
          status: {
            generation: event.generation,
            state: event.state,
            position: event.position,
            at: Date.now(),
            duration: event.duration,
          },
        });
        return;
      case "failed":
        if (!live) return;
        if (event.generation === live.generation) live.failed = true;
        emit({
          type: "media-failed",
          generation: event.generation,
          failure: { kind: "media", detail: withoutAddresses(event.message) },
        });
        return;
      case "volume":
        volume = { level: event.level, muted: event.muted };
        if (live) emit({ type: "volume", ...volume });
        return;
    }
  };

  /** A helper's process is gone. What depended on it goes with it, and another may start. */
  const ended = (was: Run, end: HelperEnd) => {
    running.delete(was.helper);
    if (run === was) run = null;
    if (closed) return;
    if (end !== "asked") {
      const failure = { kind: "unavailable", detail: "the AirPlay helper stopped" } as const;
      if (choosing) settle(choosing, new ReceiverFailed(failure));
      clearTimeout(settling);
      settling = undefined;
      // An AirPlay session lives in the helper's process, so no restart brings a receiver back.
      if (live) {
        live = null;
        emit({ type: "lost", failure });
      }
      stops = Date.now() - was.since >= timings.steady ? 1 : stops + 1;
      if (end === "unusable" || stops > RESTARTS) {
        down =
          end === "unusable"
            ? "the AirPlay helper can't start"
            : "the AirPlay helper keeps stopping";
        if (routes) tellRoutes(false);
        return;
      }
    }
    if (scanning) ensure();
  };

  /** The helper that runs, started when none does. Throws where there is none to start. */
  const ensure = (): Run => {
    if (run) return run;
    if (closed || down !== null || options.helper === null) {
      throw unavailable(down ?? "AirPlay is closed");
    }
    const started: Run = {
      since: Date.now(),
      external: false,
      helper: startHelper({
        helper: options.helper,
        args: options.args ?? [],
        start: timings.start,
        answer: timings.answer,
        quit: timings.quit,
        log: options.log ?? (() => {}),
        onEvent: (event) => {
          if (run === started) heard(started, event);
        },
        onEnd: (end) => ended(started, end),
      }),
    };
    run = started;
    running.add(started.helper);
    if (scanning) quiet({ cmd: "detect", on: true });
    return started;
  };

  return {
    kind: "airplay",
    listen(next) {
      listener = next;
    },
    scan(on) {
      if (closed || down !== null || scanning === on) return;
      scanning = on;
      if (!on) routes = null;
      if (run) quiet({ cmd: "detect", on });
      else if (on) ensure();
    },
    async connect(request, signal) {
      // AirPlay's receivers are the system's to list: the app never learns which there are.
      if (request.kind !== "picker") {
        throw unavailable("AirPlay receivers are picked in the system's list");
      }
      if (signal.aborted) throw unreachable();
      const on = ensure();
      // One list at a time: a connect that still waits gives way to this one.
      if (choosing) settle(choosing, unreachable());
      const mine: Choosing = {
        request: ++requests,
        outcome: Promise.withResolvers(),
        fresh: !on.external,
        closed: false,
        timer: undefined,
      };
      choosing = mine;
      const abort = () => settle(mine, unreachable());
      signal.addEventListener("abort", abort, { once: true });
      on.helper
        .send({ cmd: "showPicker", request: mine.request, anchor: request.anchor })
        .catch((refusal: unknown) =>
          settle(mine, refusal instanceof ReceiverFailed ? refusal : unreachable()),
        );
      try {
        return await mine.outcome.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async close() {
      const waiting = choosing;
      closed = true;
      scanning = false;
      choosing = null;
      live = null;
      run = null;
      clearTimeout(settling);
      clearTimeout(waiting?.timer);
      waiting?.outcome.reject(unreachable());
      await Promise.all([...running].map((helper) => helper.stop()));
    },
  };
}
