import { ipcMain, type WebContents } from "electron";
import { type } from "arktype";
import { AppFailure, type Result } from "../shared/errors.ts";
import {
  ipcInputs,
  type IpcEvent,
  type IpcEvents,
  type IpcInput,
  type IpcMethod,
  type IpcOutput,
} from "../shared/ipc.ts";

/** One handler per IPC method. Handlers throw `AppFailure` to fail with a specific error. */
export type IpcHandlers = {
  readonly [M in IpcMethod]: (input: IpcInput<M>) => Promise<IpcOutput<M>> | IpcOutput<M>;
};

/**
 * Registers every IPC method. Input is validated against its schema before the handler runs,
 * and any failure resolves to a typed error instead of a rejected promise.
 */
export function registerIpc(
  handlers: IpcHandlers,
  isTrusted: (sender: WebContents) => boolean,
): void {
  for (const method of Object.keys(ipcInputs) as IpcMethod[]) {
    // TypeScript cannot pair `ipcInputs[method]` with `handlers[method]` inside a loop over all
    // methods, so the loop uses erased types. `IpcHandlers` keeps each handler fully typed.
    const validate: (data: unknown) => unknown = ipcInputs[method];
    const handler = handlers[method] as (input: unknown) => unknown;

    ipcMain.handle(method, async (event, raw: unknown): Promise<Result<unknown>> => {
      if (!isTrusted(event.sender)) {
        return {
          ok: false,
          error: { kind: "unexpected", detail: "IPC call from an unknown window." },
        };
      }
      const input = validate(raw);
      if (input instanceof type.errors) {
        return {
          ok: false,
          error: { kind: "invalid-input", detail: `${method}: ${input.summary}` },
        };
      }
      try {
        return { ok: true, value: await handler(input) };
      } catch (cause) {
        if (cause instanceof AppFailure) return { ok: false, error: cause.error };
        console.error(`[ipc] ${method} failed`, cause);
        const detail = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: { kind: "unexpected", detail } };
      }
    });
  }
}

export function emit<E extends IpcEvent>(
  target: WebContents,
  event: E,
  payload: IpcEvents[E],
): void {
  if (!target.isDestroyed()) target.send(event, payload);
}
