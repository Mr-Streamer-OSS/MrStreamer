import type { QueryClient } from "@tanstack/react-query";
import { sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { t } from "@mrstreamer/core/i18n";
import { applyLanguage } from "../../app/language.ts";
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

/** Saves the current viewer before selection. A refused save never asks main to switch. */
export async function switchProfile(client: QueryClient, id: string): Promise<void> {
  const owner = profileOwner();

  if (!owner || switching) throw profileChanged();
  switching = true;
  const attempt = ++selectionAttempt;
  let selectionRequested = false;

  try {
    if (status.error === null && !(await titlePlayer.prepareProfileSwitch()))
      throw new AppFailure({
        kind: "unexpected",
        detail: t("Playback could not be saved. Try again."),
      });

    if (!currentProfile(owner)) throw profileChanged();
    selectionRequested = true;
    const selected = await callForProfile(owner, "profiles.switch", { id, current: owner });
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

export async function createProfile(client: QueryClient, name: string): Promise<void> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();
  await callForProfile(owner, "profiles.create", { name, current: owner });

  if (!currentProfile(owner)) throw profileChanged();
  await client.invalidateQueries({ queryKey: profileListQuery().queryKey });
}

export async function removeProfile(client: QueryClient, id: string): Promise<void> {
  const owner = profileOwner();

  if (!owner) throw profileChanged();

  try {
    await callForProfile(owner, "profiles.remove", { id, current: owner });
  } finally {
    // A refused deletion can leave the profile marked deleting, which the list shows for retry.
    if (currentProfile(owner))
      await client.invalidateQueries({ queryKey: profileListQuery().queryKey });
  }

  if (!currentProfile(owner)) throw profileChanged();
}
