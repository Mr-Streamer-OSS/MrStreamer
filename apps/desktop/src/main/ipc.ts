import { ipcMain, type WebContents } from "electron";
import { type } from "arktype";
import type { Result } from "@mrstreamer/contracts/errors";
import {
  ipcInputs,
  type IpcEvent,
  type IpcEvents,
  type IpcInput,
  type IpcMethod,
  type IpcOutput,
} from "@mrstreamer/contracts/ipc";
import { Diagnostics, outcomeOf } from "@mrstreamer/core/diagnostics";
import type { Failed } from "@mrstreamer/core/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** One handler per IPC method. A handler fails with `Failed` to answer with a specific error. */
export type IpcHandlers = {
  readonly [M in IpcMethod]: (input: IpcInput<M>) => Effect.Effect<IpcOutput<M>, Failed>;
};

/**
 * Registers every IPC method. Input is validated against its schema before the handler runs on
 * `run`, the main runtime, and any failure resolves to a typed error instead of a rejected promise.
 * Failed calls go to the diagnostics.
 */
export function registerIpc(
  run: <A>(effect: Effect.Effect<A, Failed>) => Promise<Exit.Exit<A, Failed>>,
  handlers: IpcHandlers,
  isTrusted: (sender: WebContents) => boolean,
): void {
  for (const method of Object.keys(ipcInputs) as IpcMethod[]) {
    // TypeScript cannot pair `ipcInputs[method]` with `handlers[method]` inside a loop over all
    // methods, so the loop uses erased types. `IpcHandlers` keeps each handler fully typed.
    const schema: () => (data: unknown) => unknown = ipcInputs[method];
    const handler = handlers[method] as (input: unknown) => Effect.Effect<unknown, Failed>;
    // Built on the method's first call, not while the app starts.
    let validate: ((data: unknown) => unknown) | null = null;

    ipcMain.handle(method, async (event, raw: unknown): Promise<Result<unknown>> => {
      if (!isTrusted(event.sender)) {
        return {
          ok: false,
          error: { kind: "unexpected", detail: "IPC call from an unknown window." },
        };
      }
      validate ??= schema();
      const input = validate(raw);
      if (input instanceof type.errors) {
        return {
          ok: false,
          error: { kind: "invalid-input", detail: `${method}: ${input.summary}` },
        };
      }
      const exit = await run(
        handler(input).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || closing(exit)
              ? Effect.void
              : Effect.map(Diagnostics, (diagnostics) =>
                  diagnostics.record({ op: "call", method, outcome: outcomeOf(exit) }),
                ),
          ),
        ),
      );
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const failed = Cause.findErrorOption(exit.cause);
      if (failed._tag === "Some") return { ok: false, error: failed.value.error };
      if (closing(exit)) return { ok: false, error: { kind: "unexpected", detail: "Closing." } };
      console.error(`[ipc] ${method} failed`, Cause.pretty(exit.cause));
      const cause = Cause.squash(exit.cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: { kind: "unexpected", detail } };
    });
  }
}

/**
 * Whether a call stopped only because the app is quitting: disposing of the runtime interrupts the
 * calls still running, and nobody waits for their answer.
 */
function closing(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
}

export function emit<E extends IpcEvent>(
  target: WebContents,
  event: E,
  payload: IpcEvents[E],
): void {
  if (!target.isDestroyed()) target.send(event, payload);
}
