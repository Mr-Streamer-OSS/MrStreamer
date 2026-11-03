import { AppFailure } from "@mrstreamer/contracts/errors";

// Which login each saved source is signed in with, and which of its list loads still count. Both
// mobile apps keep one of these: each app saves its sources, their secrets and their lists its own
// way, and asks this which answer may show. A login lives here alone, never in a store a screen
// reads, so no screen, snapshot or failure holds it.
//
// A load answers for the login it began under. It stops counting (`stands`) once another load of
// the same list begins, its source signs in again with another login, or its source signs out;
// each of those aborts its signal too, so its requests end. An answer that no longer stands is
// dropped, whenever it arrives.

/** One list load, begun for its source's login of that moment. */
export interface Load<Login> {
  readonly login: Login;
  /** Aborted once the load no longer stands. */
  readonly signal: AbortSignal;
  /** Whether its answer may still show. */
  stands(): boolean;
}

export interface SignIns<Login extends object> {
  /** `id`'s login, if signed in. */
  current(id: string): Login | undefined;
  /** `id`'s login, or a `needs-secret` failure when it has none. */
  of(id: string): Login;
  /** Every signed-in login. */
  all(): readonly Login[];
  /** How many logins were replaced or signed out so far. */
  replaced(): number;
  /** Calls `listener` after each sign-in or sign-out; answers how to stop. */
  onChange(listener: () => void): () => void;
  /** Signs `id` in with `login`, ending every load begun under the login before. */
  set(id: string, login: Login): void;
  /** Signs `id` out, ending its loads. */
  drop(id: string): void;
  /** Begins loading `id`'s `list` under its login, ending the load of it before; null when signed out. */
  begin(id: string, list: string): Load<Login> | null;
  /** Ends `id`'s loads: of `list` when given, else all. */
  stop(id: string, list?: string): void;
}

export function signIns<Login extends object>(): SignIns<Login> {
  const logins = new Map<string, Login>();
  /** The load under way of each source's lists, by source id, then list. */
  const loads = new Map<string, Map<string, AbortController>>();
  const listeners = new Set<() => void>();
  let replaced = 0;

  const stop = (id: string, list?: string) => {
    const lists = loads.get(id);

    if (!lists) return;

    for (const [each, controller] of lists) {
      if (list !== undefined && each !== list) continue;
      controller.abort();
      lists.delete(each);
    }

    if (lists.size === 0) loads.delete(id);
  };

  const changed = () => {
    for (const listener of listeners) listener();
  };

  return {
    current: (id) => logins.get(id),
    of(id) {
      const login = logins.get(id);

      if (!login) throw new AppFailure({ kind: "needs-secret", subscriptionId: id });

      return login;
    },
    all: () => [...logins.values()],
    replaced: () => replaced,
    onChange(listener) {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    set(id, login) {
      if (logins.has(id)) {
        replaced++;
        stop(id);
      }

      logins.set(id, login);
      changed();
    },
    drop(id) {
      stop(id);

      if (!logins.delete(id)) return;
      replaced++;
      changed();
    },
    begin(id, list) {
      const login = logins.get(id);

      if (!login) return null;
      stop(id, list);
      const controller = new AbortController();
      const lists = loads.get(id) ?? new Map<string, AbortController>();
      lists.set(list, controller);
      loads.set(id, lists);
      const { signal } = controller;

      return { login, signal, stands: () => !signal.aborted && logins.get(id) === login };
    },
    stop,
  };
}
