import { store, type Store } from "../platform/store.ts";
import {
  connectTv,
  onLeftApp,
  serveOnRelay,
  TvRefused,
  type Relay,
  type Tv,
  type TvLink,
  type TvLoaded,
  type TvStatus,
  type Volume,
} from "../cast/sender.ts";
import { tvPath } from "../cast/media.ts";
import type { Admission, NativePlayer, Observation } from "./native.ts";

/** The phase the player reports for what the TV says it does. */
const PHASES = {
  playing: "playing",
  paused: "paused",
  loading: "buffering",
  ended: "ended",
  failed: "failed",
  stopped: "failed",
  taken: "failed",
} as const satisfies Record<TvStatus["state"], Observation["phase"]>;

export type OutputState =
  | { readonly kind: "local" }
  | { readonly kind: "connecting"; readonly tv: Tv }
  | { readonly kind: "remote"; readonly tv: Tv }
  | {
      readonly kind: "stopped";
      readonly tv: Tv;
      readonly reason: "lost" | "foreground" | "ended" | "failed" | "stopped" | "taken" | "restore";
      /**
       * Whether the TV had taken over, so the phone shows nothing until `playHere()` returns it.
       * False when it stopped before confirmed PLAYING: the phone still plays, and `cancel()`
       * clears this state.
       */
      readonly detached: boolean;
    }
  | {
      readonly kind: "refused";
      readonly tv: Tv;
      /** Why, before anything reached the TV; "unavailable" when it couldn't be connected. */
      readonly reason: TvRefused["refusal"] | "unavailable" | "playback";
    };

/** One output of the admitted player. UI state never contains a source or relay address. */
export interface CastOutput {
  readonly state: Store<OutputState>;
  readonly volume: Store<Volume | null>;
  select(tv: Tv): Promise<boolean>;
  cancel(): Promise<void>;
  playHere(): Promise<boolean>;
  setVolume(level: number): void;
}

export function playerOutput(
  local: NativePlayer,
  canOverlap?: (sourceId: string, signal: AbortSignal) => Promise<boolean>,
): { native: NativePlayer; cast: CastOutput } {
  const state = store<OutputState>({ kind: "local" });
  const volume = store<Volume | null>(null);
  let stopVolume: (() => void) | null = null;
  const listeners = new Set<(event: Observation) => void>();
  let admission: Admission | null = null;
  let last: Observation | null = null;
  let operation: AbortController | null = null;
  let link: TvLink | null = null;
  let relay: Relay | null = null;
  let loaded: TvLoaded | null = null;
  let remote = false;
  let selecting = false;
  let selectedAudio = false;
  // The local render may not resume until all relay readers are confirmed closed.
  let closing: Promise<void> = Promise.resolve();
  const retired = new Set<Relay>();

  local.addListener("onOutputCommand", ({ attempt, command, positionMs }) => {
    if (!remote || attempt !== admission?.attempt || !loaded) return;

    if (command === "pause") loaded.pause();

    if (command === "resume") loaded.play();

    if (command === "seek" && admission.mode !== "live" && positionMs !== null)
      loaded.seek(positionMs / 1000);
  });
  local.addListener("onState", (event) => {
    if (event.attempt === admission?.attempt) {
      if (remote) return;
      last = event;
    }

    for (const listener of listeners) listener(event);
  });

  local.addListener("onTracks", (event) => {
    if (event.attempt === admission?.attempt)
      selectedAudio =
        event.tracks.filter((track) => track.type === "audio" && track.selected).length > 0 &&
        event.tracks.filter((track) => track.type === "audio").length > 1;
  });

  async function close(stop = true) {
    operation?.abort();
    operation = null;
    stopVolume?.();
    stopVolume = null;
    volume.set(null);

    const oldLink = link,
      oldRelay = relay,
      oldLoaded = loaded;

    link = null;
    relay = null;
    loaded = null;

    if (oldRelay) retired.add(oldRelay);
    const previous = closing;
    closing = (async () => {
      await previous.catch(() => {});

      try {
        if (stop) await oldLoaded?.stop();
      } finally {
        try {
          await oldLink?.close(stop);
        } finally {
          for (const pending of retired) {
            await pending.revoke();
            retired.delete(pending);
          }
        }
      }
    })();
    await closing;
  }

  function observe(status: TvStatus) {
    if (!last || !admission || !remote) return;
    const phase = PHASES[status.state];
    last = {
      ...last,
      phase,
      positionMs: status.time === null ? last.positionMs : Math.max(0, status.time * 1000),
      durationMs: status.duration === null ? null : status.duration * 1000,
      bufferedMs: 0,
      speed: 1,
      failure: phase === "failed" ? { kind: "network", code: "CAST_ENDED", status: null } : null,
    };

    void local.remotePosition?.(admission.attempt, last.positionMs);

    for (const listener of listeners) listener(last);
  }

  const cast: CastOutput = {
    state,
    volume,
    async select(tv) {
      if (!admission || !last || remote || operation || selecting) return false;
      selecting = true;
      const request = admission;
      const controller = new AbortController();
      operation = controller;
      state.set({ kind: "connecting", tv });

      let detached = false;
      const progress: { stage: "connect" | "preflight" | "load" } = { stage: "connect" };

      const active = () =>
        operation === controller && admission === request && !controller.signal.aborted;

      try {
        const container =
          request.format === "hls"
            ? "m3u8"
            : (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(request.path ?? request.url)?.[1] ?? "");

        const path = tvPath(container, request.mode === "live");

        if (path.kind === "refused") throw new TvRefused(path.refusal);

        if (selectedAudio) throw new TvRefused("audio");

        const budget =
          request.mode === "file" ||
          !!(
            request.sourceId &&
            (await canOverlap?.(request.sourceId, controller.signal).catch(() => {
              throw new TvRefused("unreadable");
            }))
          );

        if (!budget) throw new TvRefused("budget");

        const connected = await connectTv(tv, async () => {
          progress.stage = "preflight";

          if (!active()) throw new Error("Output changed");
          relay = await serveOnRelay(request.attempt, request.url, path, controller.signal);

          if (!active()) throw new Error("Output changed");
          progress.stage = "connect";
        });

        if (!active()) {
          await connected.close();

          return false;
        }

        link = connected;
        volume.set(connected.volume.get());
        stopVolume = connected.volume.subscribe(() => volume.set(connected.volume.get()));
        void connected.lost.then((reason) => {
          if (link !== connected) return;
          state.set({ kind: "stopped", tv, reason, detached: remote });
          observe({ state: "failed", time: (last?.positionMs ?? 0) / 1000, duration: null });
          void close(false).catch(() => {});
        });

        // A preflighted relay must exist before receiver LOAD.
        if (!relay) throw new TvRefused("unreadable");
        progress.stage = "load";

        if (!active()) {
          await close();

          return false;
        }

        let playing!: () => void;

        const confirmed = new Promise<void>((resolve) => {
          playing = resolve;
        });

        let latest: TvStatus | null = null;
        loaded = await connected.load(
          {
            address: relay.address,
            contentType: relay.contentType,
            segments: relay.segments,
            live: request.mode === "live",
            title: request.title ?? "",
            from: last.positionMs / 1000,
          },
          (status) => {
            if (!active()) return;
            latest = status;

            if (status.state === "playing") playing();

            if (remote) observe(status);

            if (["failed", "stopped", "taken", "ended"].includes(status.state)) {
              state.set({
                kind: "stopped",
                tv,
                reason:
                  status.state === "ended" || status.state === "taken" || status.state === "stopped"
                    ? status.state
                    : "failed",
                detached: remote,
              });
              void close(status.state !== "taken").catch(() => {});
            }
          },
          controller.signal,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;

        const abort = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error("Cast cancelled"));
          controller.signal.addEventListener("abort", fail, { once: true });

          if (controller.signal.aborted) fail();
          timer = setTimeout(() => reject(new Error("TV did not report playback")), 8000);
        });

        try {
          await Promise.race([confirmed, abort]);
        } finally {
          clearTimeout(timer);
        }

        if (!active() || !(await local.remoteOutput?.(request.attempt)))
          throw new Error("Output changed");
        detached = true;
        remote = true;

        if (!active()) throw new Error("Output changed");
        state.set({ kind: "remote", tv });

        if (latest) observe(latest);

        return true;
      } catch (cause) {
        const current = active();
        let drained = false;

        try {
          await close();
          drained = true;
        } catch {
          /* The native hold remains unconfirmed. */
        }

        if (detached && drained && admission === request) {
          const restored = await local.localOutput?.(
            request.attempt,
            last?.positionMs ?? request.startMs,
          );

          if (restored) {
            remote = false;
            state.set({ kind: "local" });
          }
        }

        if (current)
          state.set({
            kind: "refused",
            tv,
            reason:
              cause instanceof TvRefused
                ? cause.refusal
                : progress.stage === "load"
                  ? "playback"
                  : progress.stage === "preflight"
                    ? "unreadable"
                    : "unavailable",
          });

        return false;
      } finally {
        selecting = false;
      }
    },
    async cancel() {
      await close();

      if (!remote) state.set({ kind: "local" });
    },
    async playHere() {
      const request = admission;
      const position = last?.positionMs ?? 0;
      const previous = state.get();

      if (previous.kind !== "local")
        state.set({ kind: "stopped", tv: previous.tv, reason: "restore", detached: remote });
      await close();

      if (!request || admission !== request) return false;
      const accepted = (await local.localOutput?.(request.attempt, position)) ?? false;

      if (accepted) {
        remote = false;
        state.set({ kind: "local" });
      }

      return accepted;
    },
    setVolume(level) {
      if (Number.isFinite(level)) link?.setVolume(Math.max(0, Math.min(1, level)));
    },
  };

  onLeftApp(() => {
    const now = state.get();

    if (now.kind === "remote" || now.kind === "connecting")
      state.set({ kind: "stopped", tv: now.tv, reason: "foreground", detached: remote });
    observe({ state: "failed", time: (last?.positionMs ?? 0) / 1000, duration: null });
    void close().catch(() => {});
  });

  type EventBridge = (event: string, listener: (value: never) => void) => { remove(): void };

  const addListener: NativePlayer["addListener"] = ((
    event: string,
    listener: (value: never) => void,
  ) => {
    if (event !== "onState") return (local.addListener as EventBridge)(event, listener);
    const observation = listener as (value: Observation) => void;
    listeners.add(observation);

    return { remove: () => listeners.delete(observation) };
  }) as NativePlayer["addListener"];

  const native: NativePlayer = {
    addListener,
    admit(request) {
      const admit = () => {
        remote = false;
        admission = request;
        selectedAudio = false;
        last = null;
        state.set({ kind: "local" });

        return local.admit(request);
      };

      return operation || link || relay || retired.size > 0 ? close().then(admit) : admit();
    },
    stop(attempt) {
      if (admission?.attempt !== attempt) return local.stop(attempt);

      const stop = () => {
        remote = false;
        admission = null;
        state.set({ kind: "local" });

        return local.stop(attempt);
      };

      if (!operation && !link && !relay && retired.size === 0) return stop();

      return close().then(stop, async (cause: unknown) => {
        await stop();
        throw cause;
      });
    },
    async pause(attempt) {
      if (!remote) return local.pause(attempt);

      if (!loaded || attempt !== admission?.attempt) return false;
      loaded.pause();

      return true;
    },
    async resume(attempt) {
      if (!remote) return local.resume(attempt);

      if (!loaded || attempt !== admission?.attempt) return false;
      loaded.play();

      return true;
    },
    async seek(attempt, position) {
      if (!remote) return local.seek(attempt, position);

      if (
        !loaded ||
        attempt !== admission?.attempt ||
        admission.mode === "live" ||
        !Number.isFinite(position)
      )
        return false;
      loaded.seek(position / 1000);

      return true;
    },
    setSpeed: (attempt, speed) =>
      remote ? Promise.resolve(false) : local.setSpeed(attempt, speed),
    setQuality: (attempt, track) =>
      remote ? Promise.resolve(false) : local.setQuality(attempt, track),
    setAudio: (attempt, track) =>
      remote
        ? Promise.resolve(false)
        : (local.setAudio?.(attempt, track) ?? Promise.resolve(false)),
    setText: (attempt, track) =>
      remote ? Promise.resolve(false) : (local.setText?.(attempt, track) ?? Promise.resolve(false)),
    setSidecar: (attempt, text, language, offset, speed) =>
      remote
        ? Promise.resolve(false)
        : (local.setSidecar?.(attempt, text, language, offset, speed) ?? Promise.resolve(false)),
    enterPip: () =>
      remote ? Promise.resolve(false) : (local.enterPip?.() ?? Promise.resolve(false)),
    capabilities: () => local.capabilities(),
    setSubtitleInset: (fraction) => local.setSubtitleInset?.(fraction) ?? Promise.resolve(),
    setSubtitleSize: (size) => local.setSubtitleSize?.(size) ?? Promise.resolve(),
    unpackSubtitle: (bytes) =>
      local.unpackSubtitle?.(bytes) ?? Promise.reject(new Error("Subtitles unavailable")),
    setNextAvailable: (attempt, available) =>
      local.setNextAvailable?.(attempt, available) ?? Promise.resolve(),
    setWatch: (visible) => local.setWatch?.(visible) ?? Promise.resolve(),
    pipSupported: () => !remote && (local.pipSupported?.() ?? false),
    reconcile: () => local.reconcile?.() ?? Promise.resolve(),
  };

  return { native, cast };
}
