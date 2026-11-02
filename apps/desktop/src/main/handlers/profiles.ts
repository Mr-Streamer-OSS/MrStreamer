import type { HandlersFor } from "../ipc.ts";
import type { Profiles } from "../platform/profile-store.ts";

export function profileHandlers({
  profiles,
}: {
  readonly profiles: Profiles["Service"];
}): HandlersFor<"profiles"> {
  return {
    "profiles.active": () => profiles.active,
  };
}
