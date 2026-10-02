// Stands in for the main process in the renderer's tests, which run with happy-dom. Every call is
// recorded; a call the test holds answers when the test says, the preferences otherwise answer
// with the defaults, and anything else never answers. Tests send its events themselves. Import it
// first, before the renderer's modules: it also stands in for Media Source Extensions, which
// happy-dom lacks.
import type { AppError, Result } from "@mrstreamer/contracts/errors";
import type {
  BridgeApi,
  IpcEvent,
  IpcEvents,
  IpcMethod,
  IpcOutput,
} from "@mrstreamer/contracts/ipc";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";

const held = new Map<IpcMethod, Promise<Result<unknown>>[]>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const calls: { readonly method: IpcMethod; readonly args: unknown }[] = [];

export const ipc = {
  /** The arguments of each call to `method` so far. */
  argsOf: (method: IpcMethod): unknown[] =>
    calls.filter((each) => each.method === method).map((each) => each.args),
  /** The methods called so far, in order. */
  methods: (): IpcMethod[] => calls.map((each) => each.method),
  /** Holds the next call to `method` until the test answers it. */
  hold<M extends IpcMethod>(method: M) {
    let settle: (result: Result<unknown>) => void = () => {};
    const answer = new Promise<Result<unknown>>((resolve) => (settle = resolve));
    held.set(method, [...(held.get(method) ?? []), answer]);
    return {
      resolve: (value: IpcOutput<M>) => settle({ ok: true, value }),
      reject: (error: AppError) => settle({ ok: false, error }),
    };
  },
  /** Sends an event from the main process. */
  emit<E extends IpcEvent>(event: E, payload: IpcEvents[E]): void {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  },
  /** Forgets the calls and held answers of the test before. */
  reset(): void {
    calls.length = 0;
    held.clear();
  },
};

const bridge = {
  invoke(method: IpcMethod, args?: unknown): Promise<Result<unknown>> {
    calls.push({ method, args });
    const answer = held.get(method)?.shift();
    if (answer) return answer;
    if (method === "preferences.get") {
      return Promise.resolve({ ok: true, value: defaultPreferences });
    }
    return new Promise(() => {});
  },
  on(event: string, listener: (payload: unknown) => void) {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return () => set.delete(listener);
  },
};

/**
 * happy-dom has no Media Source Extensions. This stand-in opens and takes no data, so a title's
 * run gets as far as its subtitles, and no further. It plays no codec, so live streams keep to
 * the element's own engine rather than hls.js or mpegts.js.
 */
class StandInMediaSource extends EventTarget {
  static isTypeSupported = () => false;
  readyState = "closed";
  constructor() {
    super();
    setTimeout(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  endOfStream(): void {}
}
Object.assign(globalThis, { MediaSource: StandInMediaSource });
// The element gets an address for it, as it would for a real one.
const objectUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object) =>
  object instanceof StandInMediaSource ? "blob:stand-in" : objectUrl(object);

// The contract types each method's answer; the stand-in answers whatever the test gives.
const api: BridgeApi = bridge as unknown as BridgeApi;
Object.assign(window, { mrStreamer: api });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
