import { sources } from "../bootstrap/sources.ts";
import { player } from "../player/instance.ts";
import { statistics } from "../telemetry/index.ts";
import { providerRecovery } from "./recovery.ts";

/** Settings reports the discard result for its own removals; external removals use the observer. */
export const recovery = providerRecovery(
  sources,
  () => statistics.discard(),
  player,
  async (id) => (await import("../home/index.ts")).clearViewing(id),
);
