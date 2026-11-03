import manifest from "../../licenses/manifest.json";

/** The only inventory and count Settings displays, generated from this Android build's inputs. */
export const licences = manifest;
export const licenceCount = licences.length;

export function licenceAt(index: number) {
  return Number.isInteger(index) && index >= 0 ? (licences[index] ?? null) : null;
}
