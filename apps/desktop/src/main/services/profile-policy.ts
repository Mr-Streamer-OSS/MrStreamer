import * as Context from "effect/Context";
import type { KidsApproval } from "@mrstreamer/contracts/profiles";

/** Private admitted policy for catalogue calls. Missing means a household/background operation. */
export class AdmittedKids extends Context.Service<
  AdmittedKids,
  { readonly approved: readonly KidsApproval[] | null }
>()("mrstreamer/AdmittedKids") {}

/** Exact identities only. Null is an admitted adult; an empty list grants no kids content. */
export function allowsApproval(
  approved: readonly KidsApproval[] | null,
  approval: KidsApproval,
): boolean {
  return (
    approved === null ||
    approved.some(
      (item) =>
        item.kind === approval.kind &&
        item.id === approval.id &&
        (!("subscriptionId" in approval) ||
          ("subscriptionId" in item && item.subscriptionId === approval.subscriptionId)),
    )
  );
}
