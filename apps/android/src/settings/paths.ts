import { destinationIn } from "../navigation/open.ts";
import { START_DESTINATION } from "../navigation/destinations.ts";

/**
 * The path of a Settings screen (`licences`) on the stack Settings shows on, from the router's
 * segments, so Back returns to Settings there: Live's at the root, the others under theirs.
 */
export function onStack(segments: readonly string[], screen: "licences"): string {
  const destination = destinationIn(segments);

  return destination === START_DESTINATION ? `/${screen}` : `/${destination}/${screen}`;
}
