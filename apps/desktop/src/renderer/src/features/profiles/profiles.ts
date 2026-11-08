import type { QueryClient } from "@tanstack/react-query";
import {
  sameProfile,
  type ActiveProfile,
  type KidsPolicy,
  type KidsProfilePolicy,
} from "@mrstreamer/contracts/profiles";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { defined } from "@mrstreamer/core/defined";
import { t } from "@mrstreamer/core/i18n";
import { applyLanguage } from "../../app/language.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { resetForProfile } from "../../app/ui-store.ts";
import {
  call,
  callForProfile,
  currentProfile,
  currentProfileReply,
  listen,
  profileChanged,
  profileOwner,
  selectProfileOwner,
} from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { player } from "../../player/player.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { outputs } from "../../player/output.ts";

async function reloadLanguage(
  client: QueryClient,
  owner: ActiveProfile,
  generation: number,
): Promise<void> {
  const language = await callForProfile(owner, "language.get");

  if (generation !== lifetime || !currentProfile(owner) || !currentProfileReply(language))
    throw profileChanged();
  client.setQueryData(queries.language().queryKey, language);
  applyLanguage(language);
}

interface ProfileStatus {
  readonly owner: ActiveProfile | null;
  readonly pending: boolean;
  readonly error: unknown;
}

let status: ProfileStatus = { owner: null, pending: true, error: null };
const listeners = new Set<() => void>();
export const profileStatus = () => status;

export function subscribeProfiles(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function publish(next: ProfileStatus): void {
  status = next;

  for (const listener of listeners) listener();
}

let lifetime = 0;
let selectionAttempt = 0;
let recoverySelection: ActiveProfile | null = null;

let applying: {
  readonly owner: ActiveProfile;
  readonly generation: number;
  readonly promise: Promise<void>;
} | null = null;

/** Every old query is removed and the screen remounts; no old-owner cache survives a switch. */
async function changeOwner(
  client: QueryClient,
  owner: ActiveProfile,
  generation: number,
): Promise<void> {
  if (generation !== lifetime) throw profileChanged();
  const before = profileOwner();

  if (before && owner.revision < before.revision) throw profileChanged();
  const same = currentProfile(owner);

  if (before && !same) {
    // Preserve closeTitle's save-before-reset order, including its sought-copy recovery.
    titlePlayer.clearForProfile();
    player.clearForProfile();
    resetForProfile();
  }

  if (same) {
    await Promise.all([reloadLanguage(client, owner, generation), outputs.refreshForProfile()]);

    return;
  }

  await client.cancelQueries();
  // A newer switch may have completed while cancellation waited. Never restore an older owner.
  const current = profileOwner();

  if (
    generation !== lifetime ||
    (current && !currentProfile(owner) && current.revision >= owner.revision)
  )
    throw profileChanged();
  client.clear();
  selectProfileOwner(owner);

  if (before) outputs.clearForProfile(owner);
  await Promise.all([reloadLanguage(client, owner, generation), outputs.refreshForProfile()]);
}

/** Selection is observable as complete only after private reads and locale/output reload succeed. */
function acceptOwner(
  client: QueryClient,
  owner: ActiveProfile,
  generation = lifetime,
): Promise<void> {
  if (generation !== lifetime) return Promise.reject(profileChanged());

  if (applying && applying.generation === generation && sameProfile(applying.owner, owner))
    return applying.promise;

  if (
    currentProfile(owner) &&
    status.owner?.revision === owner.revision &&
    status.error === null &&
    !status.pending
  )
    return Promise.resolve();

  const task = {
    owner,
    generation,
    promise: Promise.resolve()
      .then(() => changeOwner(client, owner, generation))
      .then(
        () => {
          if (generation !== lifetime || !currentProfile(owner)) throw profileChanged();

          if (recoverySelection && sameProfile(recoverySelection, owner)) recoverySelection = null;
          publish({ owner, pending: false, error: null });
        },
        (cause: unknown) => {
          if (generation === lifetime && status.owner && sameProfile(status.owner, owner))
            publish({ owner, pending: false, error: cause });
          throw cause;
        },
      )
      .finally(() => {
        if (applying === task) applying = null;
      }),
  };

  applying = task;
  publish({ owner, pending: true, error: null });

  return task.promise;
}

/** Installs profile events at composition; initial ownership does not reset the background-Quit view. */
export function syncProfiles(client: QueryClient): () => void {
  const retry = status.error !== null && status.owner !== null && currentProfile(status.owner);
  const generation = ++lifetime;
  publish({ owner: profileOwner(), pending: true, error: null });
  let alive = true;

  const apply = (owner: ActiveProfile) => {
    if (!alive) return;
    void acceptOwner(client, owner, generation).catch((cause: unknown) => {
      if (alive && generation === lifetime && currentProfile(owner) && status.error === null)
        publish({ owner, pending: false, error: cause });
    });
  };

  const stop = listen("profiles.activeChanged", (owner) => {
    selectionAttempt++;
    apply(owner);
  });

  void call("profiles.active")
    .then(async (owner) => {
      if (!alive || generation !== lifetime) return;

      if (retry) {
        // Retry exactly the durable selection, without replaying an obsolete playback save.
        const selected = await call("profiles.switch", { id: owner.id, current: owner });

        if (!alive || generation !== lifetime) return;
        apply(selected);
      } else apply(owner);
    })
    .catch((cause: unknown) => {
      if (alive && generation === lifetime)
        publish({ owner: profileOwner(), pending: false, error: cause });
    });

  return () => {
    alive = false;
    stop();

    if (generation === lifetime) {
      lifetime++;
      publish({ owner: profileOwner(), pending: true, error: status.error });
    }
  };
}

let switching = false;

/**
 * Saves the current viewer before selection. A refused save never asks main to switch. `pin` is
 * needed only to leave a kids profile for an adult one; it travels in this call and nowhere else.
 */
export async function switchProfile(client: QueryClient, id: string, pin?: string): Promise<void> {
  const owner = profileOwner();

  if (!owner || switching) throw profileChanged();
  switching = true;
  const attempt = ++selectionAttempt;
  let selectionRequested = false;

  try {
    // Only a confirmed committed selection makes the former viewer's playback save obsolete.
    const recovering = recoverySelection && sameProfile(recoverySelection, owner);

    if (!recovering && !(await titlePlayer.prepareProfileSwitch()))
      throw new AppFailure({
        kind: "unexpected",
        detail: t("Playback could not be saved. Try again."),
      });

    if (!currentProfile(owner)) throw profileChanged();
    selectionRequested = true;

    const selected = await callForProfile(owner, "profiles.switch", {
      id,
      current: owner,
      ...defined({ pin }),
    });

    if (!sameProfile(selected, owner)) recoverySelection = selected;
    await acceptOwner(client, selected);
  } catch (cause) {
    if (!selectionRequested) throw cause;
    // A failed configuration may follow a committed selection. Read that durable owner;
    // never retry the queued request with a substituted owner. Recovery is a new user action.
    const generation = lifetime;

    try {
      const selected = await call("profiles.active");

      if (
        attempt === selectionAttempt &&
        generation === lifetime &&
        currentProfile(owner) &&
        !sameProfile(selected, owner)
      ) {
        recoverySelection = selected;
        await acceptOwner(client, selected).catch(() => {});

        if (attempt === selectionAttempt && generation === lifetime && currentProfile(selected))
          publish({ owner: selected, pending: false, error: cause });
      }
    } catch {
      if (attempt === selectionAttempt && generation === lifetime)
        publish({ owner: profileOwner(), pending: false, error: cause });
    }

    throw cause;
  } finally {
    switching = false;
  }
}

export const profileListQuery = () => ({
  queryKey: ["profiles", "list"] as const,
  queryFn: () => call("profiles.list"),
});

/** Once a PIN protects the installation, adding a profile needs it. */
export async function createProfile(
  client: QueryClient,
  name: string,
  pin?: string,
): Promise<void> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();
  await callForProfile(owner, "profiles.create", { name, current: owner, ...defined({ pin }) });

  if (!currentProfile(owner)) throw profileChanged();
  await client.invalidateQueries({ queryKey: profileListQuery().queryKey });
}

/** Once a PIN protects the installation, deleting a profile needs it. */
export async function removeProfile(client: QueryClient, id: string, pin?: string): Promise<void> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();

  try {
    await callForProfile(owner, "profiles.remove", { id, current: owner, ...defined({ pin }) });
  } finally {
    // A refused deletion can leave the profile marked deleting, which the list shows for retry.
    if (currentProfile(owner))
      await client.invalidateQueries({ queryKey: profileListQuery().queryKey });
  }

  if (!currentProfile(owner)) throw profileChanged();
}

/** Main's kids policy refusals, already whole sentences in the window's language. */
const POLICY_REFUSALS = [
  "Kids policy could not be read or saved. Try again.",
  "Kids policy: enter the correct PIN.",
  "Kids policy: this content or action is not approved.",
] as const;

/** One sentence for a failed profile read or change, showing main's kids policy refusals as said. */
export function describeProfileError(cause: unknown): string {
  const error = appError(cause);

  return "detail" in error && POLICY_REFUSALS.some((refusal) => t(refusal) === error.detail)
    ? error.detail
    : describeError(error);
}

/**
 * Whether main refused a profile change for a missing or wrong PIN. Main says so only in its
 * message, translated with the same catalogue, so the window compares that sentence.
 */
export const pinRefused = (cause: unknown) =>
  cause instanceof AppFailure &&
  cause.error.kind === "invalid-input" &&
  cause.error.detail === t("Kids policy: enter the correct PIN.");

/**
 * The kids policy as the current adult viewer manages it. Without `pin` it answers only while no
 * PIN protects the installation, which is how the manager learns whether to ask for one.
 */
export async function readKidsPolicy(pin?: string): Promise<KidsPolicy> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();

  const policy = await callForProfile(owner, "profiles.policy", {
    current: owner,
    ...defined({ pin }),
  });

  if (!currentProfile(owner)) throw profileChanged();

  return policy;
}

/**
 * Replaces every kids profile and its approvals at once. `pin` is the current PIN once one is set;
 * `newPin` sets the first one or changes it. A refused save keeps the policy main had.
 */
export async function saveKidsPolicy(
  client: QueryClient,
  change: {
    readonly pin: string | undefined;
    readonly newPin: string | undefined;
    readonly profiles: readonly KidsProfilePolicy[];
  },
): Promise<KidsPolicy> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();

  const policy = await callForProfile(owner, "profiles.setPolicy", {
    current: owner,
    profiles: [...change.profiles],
    ...defined({ pin: change.pin, newPin: change.newPin }),
  });

  if (!currentProfile(owner)) throw profileChanged();
  await client.invalidateQueries({ queryKey: profileListQuery().queryKey });

  return policy;
}
