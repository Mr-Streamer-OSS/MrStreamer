import { type } from "arktype";
import { ownedByProfile, sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import { t } from "@mrstreamer/core/i18n";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type {
  IpcArgs,
  IpcCallArgs,
  IpcEvent,
  IpcEvents,
  IpcInput,
  IpcMethod,
  IpcOutput,
} from "@mrstreamer/contracts/ipc";

let selectedProfile: ActiveProfile | null = null;
let profileGeneration = 0;

const replyOwners = new WeakMap<
  object,
  { readonly owner: ActiveProfile | null; readonly generation: number }
>();

/** Replies may be delivered to a cache after the invoking promise itself has already settled. */
export function currentProfileReply<Reply extends object>(reply: Reply): boolean {
  const captured = replyOwners.get(reply);

  return captured
    ? captured.generation === profileGeneration && currentProfile(captured.owner)
    : selectedProfile === null;
}

/** Namespaced events must carry a matching immutable owner before their data enters a cache. */
export function ownProfileReply<Reply extends object>(reply: Reply, owner: ActiveProfile): boolean {
  if (!currentProfile(owner)) return false;
  replyOwners.set(reply, { owner, generation: profileGeneration });

  return true;
}

/** The immutable owner used by new requests; null only before the window initializes. */
export const profileOwner = () => selectedProfile;

export function currentProfile(owner: ActiveProfile | null): boolean {
  return (
    owner === selectedProfile ||
    (!!owner && !!selectedProfile && sameProfile(owner, selectedProfile))
  );
}

export function selectProfileOwner(owner: ActiveProfile | null): void {
  if (owner !== null && currentProfile(owner)) return;
  profileGeneration++;
  selectedProfile = owner ? { ...owner } : null;
}

/** A reply or command begun for a viewer who is no longer selected. */
export function profileChanged(): AppFailure {
  return new AppFailure({ kind: "unexpected", detail: t("Viewing profile changed. Try again.") });
}

/** Deferred personal commands retain the owner from the user action, never the timer's viewer. */
export function callForProfile<M extends IpcMethod>(
  owner: ActiveProfile | null,
  method: M,
  ...args: IpcCallArgs<M>
): Promise<IpcOutput<M>> {
  return currentProfile(owner) ? call(method, ...args) : Promise.reject(profileChanged());
}

/** Calls the main process. Resolves with the result or throws `AppFailure` carrying a typed error. */
export async function call<M extends IpcMethod>(
  method: M,
  ...args: IpcCallArgs<M>
): Promise<IpcOutput<M>> {
  const owner = profileOwner();
  const generation = profileGeneration;

  const transport: IpcArgs<M> =
    owner && ownedByProfile(method) ? [{ __profile: owner, input: args[0] }] : args;

  const result = await window.mrStreamer.invoke(method, ...transport);

  if (
    method !== "profiles.active" &&
    method !== "profiles.switch" &&
    !method.startsWith("analytics.") &&
    (!currentProfile(owner) || generation !== profileGeneration)
  )
    throw profileChanged();

  if (!result.ok) throw new AppFailure(result.error);

  if (type.keywords.object.root.allows(result.value))
    replyOwners.set(result.value, { owner, generation });

  return result.value;
}

/** Subscribes to an event from the main process. Returns the unsubscribe function. */
export function listen<E extends IpcEvent>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
): () => void {
  return window.mrStreamer.on(event, listener);
}

/** TanStack owns the signal: a shared query is cancelled only after its last observer leaves. */
export async function searchCall<
  M extends "guide.search" | "guide.searchList" | "guide.searchPage",
>(method: M, input: IpcInput<M>, signal: AbortSignal, view: string): Promise<IpcOutput<M>> {
  const owner = profileOwner();
  const generation = profileGeneration;

  if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
  const request = { view, id: crypto.randomUUID() };

  const cancel = () => {
    void call("guide.cancelSearch", request).catch(() => {});
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    const result = await window.mrStreamer.invoke(method, {
      __profile: owner ?? undefined,
      input: { ...input, request },
    });

    if (!currentProfile(owner) || generation !== profileGeneration) throw profileChanged();

    if (!result.ok) throw new AppFailure(result.error);

    if (type.keywords.object.root.allows(result.value))
      replyOwners.set(result.value, { owner, generation });

    return result.value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
