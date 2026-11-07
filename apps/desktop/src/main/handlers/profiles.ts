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
    "profiles.active": () => profiles.active,
    "profiles.list": () => (enabled && sessions ? sessions.list : unavailable),
    "profiles.create": ({ name, current }) =>
      enabled && sessions ? sessions.create(name, current) : unavailable,
    "profiles.switch": ({ id, current }) =>
      enabled && sessions ? sessions.switch(id, current) : unavailable,
    "profiles.remove": ({ id, current }) =>
      enabled && sessions ? Effect.as(sessions.remove(id, current), null) : unavailable,
  };
}
