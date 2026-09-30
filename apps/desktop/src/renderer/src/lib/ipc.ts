import { AppFailure } from "@mrstreamer/contracts/errors";
import type { IpcArgs, IpcEvent, IpcEvents, IpcMethod, IpcOutput } from "@mrstreamer/contracts/ipc";

/** Calls the main process. Resolves with the result or throws `AppFailure` carrying a typed error. */
export async function call<M extends IpcMethod>(
  method: M,
  ...args: IpcArgs<M>
): Promise<IpcOutput<M>> {
  const result = await window.mrStreamer.invoke(method, ...args);
  if (!result.ok) throw new AppFailure(result.error);
  return result.value;
}

/** Subscribes to an event from the main process. Returns the unsubscribe function. */
export function listen<E extends IpcEvent>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
): () => void {
  return window.mrStreamer.on(event, listener);
}
