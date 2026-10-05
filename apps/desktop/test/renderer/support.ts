// Stands in for the main process in the renderer's tests, which run with happy-dom. Every call is
// recorded; a call the test holds answers when the test says, the preferences otherwise answer
// with the defaults and what the test says the viewer saved, and anything else never answers.
// Like the main process, it refuses a call whose input the contract doesn't allow, so a view
// can't pass here with a call that fails there. Tests send its events themselves. Import it
// first, before the renderer's modules: it also stands in for Media Source Extensions, which
// happy-dom lacks, and for a text track's hidden mode, which it refuses.
import { type } from "arktype";
import type { AppError, Result } from "@mrstreamer/contracts/errors";
import {
  ipcInputs,
  type BridgeApi,
  type IpcEvent,
  type IpcEvents,
  type IpcMethod,
  type IpcOutput,
} from "@mrstreamer/contracts/ipc";
import { defaultPreferences, type Preferences } from "@mrstreamer/contracts/preferences";

const held = new Map<IpcMethod, Promise<Result<unknown>>[]>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const calls: { readonly method: IpcMethod; readonly args: unknown }[] = [];
let preferences = defaultPreferences;

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
  /** Answers the preferences with `saved` over the defaults, as after the viewer set them. */
  prefer(saved: Partial<Preferences>): void {
    preferences = { ...defaultPreferences, ...saved };
  },
  /** Forgets the calls, held answers and saved preferences of the test before. */
  reset(): void {
    calls.length = 0;
    held.clear();
    preferences = defaultPreferences;
  },
};

const bridge = {
  invoke(method: IpcMethod, args?: unknown): Promise<Result<unknown>> {
    const schema: () => (data: unknown) => unknown = ipcInputs[method];
    const input = schema()(args);
    if (input instanceof type.errors) {
      return Promise.resolve({
        ok: false,
        error: { kind: "invalid-input", detail: `${method}: ${input.summary}` },
      });
    }
    calls.push({ method, args });
    const answer = held.get(method)?.shift();
    if (answer) return answer;
    if (method === "preferences.get") {
      return Promise.resolve({ ok: true, value: preferences });
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

/**
 * happy-dom refuses a text track's "hidden" mode, in which a browser times the cues and draws
 * none, and lists the cues of no track it leaves disabled. Showing stands in for it here: the cues
 * are listed, and happy-dom draws nothing either way. It times none, so a test moves the element's
 * clock and sends `seeked` itself.
 */
const inherited: object = Object.getPrototypeOf(TextTrack.prototype);
Object.defineProperty(TextTrack.prototype, "mode", {
  configurable: true,
  get(this: TextTrack): TextTrackMode {
    return Reflect.get(inherited, "mode", this);
  },
  set(this: TextTrack, mode: TextTrackMode) {
    Reflect.set(inherited, "mode", mode === "hidden" ? "showing" : mode, this);
  },
});

// The contract types each method's answer; the stand-in answers whatever the test gives.
const api: BridgeApi = bridge as unknown as BridgeApi;
Object.assign(window, { mrStreamer: api });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
