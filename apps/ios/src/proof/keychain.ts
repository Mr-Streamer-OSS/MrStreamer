import type { Observed } from "./cases.ts";
import type { SecretStore } from "../secrets.ts";

const RELAUNCH = "proof:relaunch";
const ROUND_TRIP = "proof:round trip/ü";

/**
 * The secret store against the real Keychain: an id with characters Keychain keys refuse, a
 * removal, and a value written by the previous launch, so a relaunch shows what survived it.
 * Only made-up values are written.
 */
export async function keychainProof(store: SecretStore): Promise<Observed> {
  const previous = await store.read(RELAUNCH);
  const launch = previous?.startsWith("launch-") ? Number(previous.slice(7)) + 1 : 1;
  await store.write(RELAUNCH, `launch-${launch}`);

  await store.write(ROUND_TRIP, "pässwörd with spaces");
  const readBack = await store.read(ROUND_TRIP);
  await store.remove(ROUND_TRIP);
  const afterRemove = await store.read(ROUND_TRIP);
  return { previous, launch, roundTrip: readBack === "pässwörd with spaces", afterRemove };
}
