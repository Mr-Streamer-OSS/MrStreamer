// Google Cast: finds the Cast receivers on the local network (./discovery), connects to one over
// a Cast channel (./channel), starts Google's Default Media Receiver on it and has that play the
// address the output service hands over (./session). It is a sender of its own, with only what
// playing one HLS stream needs, and no receiver has been in reach to try it on.
import { ReceiverFailed, type AdapterEvent, type ReceiverAdapter } from "../adapter.ts";
import { castDiscovery, type CastDiscovery } from "./discovery.ts";
import { CAST_TIMINGS, openSession, type CastTimings, type Session } from "./session.ts";

export interface CastOptions {
  /** Finds the receivers, in place of the mDNS browse: for tests. */
  readonly discovery?: CastDiscovery;
  /** How long the adapter waits at each step, where a test wants it shorter. */
  readonly timings?: Partial<CastTimings>;
}

/** The Cast adapter. It opens nothing until it scans or connects. */
export function castAdapter(options: CastOptions = {}): ReceiverAdapter {
  const timings = { ...CAST_TIMINGS, ...options.timings };
  const discovery = options.discovery ?? castDiscovery();
  let listener: (event: AdapterEvent) => void = () => {};
  /** The connect under way: the next one, and closing, give it up. */
  let connecting = new AbortController();
  let session: Session | null = null;
  let closed = false;

  const emit = (event: AdapterEvent) => {
    if (!closed) listener(event);
  };
  discovery.listen((receivers) => emit({ type: "receivers", receivers }));

  return {
    kind: "cast",
    listen(next) {
      listener = next;
    },
    scan(on) {
      if (!closed) discovery.scan(on);
    },
    async connect(request, signal) {
      // Cast has no list of the system's: the app lists the receivers it found itself.
      if (request.kind === "picker") {
        throw new ReceiverFailed({ kind: "unavailable", detail: "Cast has no system picker" });
      }
      const endpoint = discovery.locate(request.id);
      if (!endpoint || closed) throw new ReceiverFailed({ kind: "unreachable" });
      connecting.abort();
      const mine = (connecting = new AbortController());
      // One receiver at a time: the one before is let go of first.
      await session?.disconnect();
      const opened = await openSession(
        endpoint,
        timings,
        emit,
        AbortSignal.any([signal, mine.signal]),
      );
      session = opened;
      if (closed) {
        await opened.disconnect();
        throw new ReceiverFailed({ kind: "unreachable" });
      }
      return opened.connection;
    },
    async close() {
      closed = true;
      connecting.abort();
      discovery.scan(false);
      await session?.disconnect();
    },
  };
}
