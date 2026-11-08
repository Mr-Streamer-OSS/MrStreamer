import { t } from "@mrstreamer/core/i18n";
import * as Effect from "effect/Effect";
import { Failed } from "@mrstreamer/core/failure";
import type { ProfileSessions } from "../services/profiles.ts";
import type { HandlersFor } from "../ipc.ts";
import type { Profiles } from "../platform/profile-store.ts";

export function profileHandlers({
  profiles,
  sessions,
  enabled = false,
}: {
  readonly profiles: Profiles["Service"];
  readonly sessions?: ProfileSessions["Service"];
  readonly enabled?: boolean;
}): HandlersFor<"profiles"> {
  const unavailable = Effect.fail(
    new Failed({ error: { kind: "unexpected", detail: t("Profile isolation is not ready.") } }),
  );

  return {
    "profiles.policy": ({ current, pin }) =>
      enabled && sessions ? sessions.policy(current, pin) : unavailable,
    "profiles.setPolicy": (input) =>
      enabled && sessions ? sessions.setPolicy(input) : unavailable,
    "profiles.active": () => profiles.active,
    "profiles.list": () => (enabled && sessions ? sessions.list : unavailable),
    "profiles.create": ({ name, current, pin }) =>
      enabled && sessions ? sessions.create(name, current, pin) : unavailable,
    "profiles.switch": ({ id, current, pin }) =>
      enabled && sessions ? sessions.switch(id, current, pin) : unavailable,
    "profiles.remove": ({ id, current, pin }) =>
      enabled && sessions ? Effect.as(sessions.remove(id, current, pin), null) : unavailable,
  };
}
