import * as Context from "effect/Context";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import type { OutputStatus } from "@mrstreamer/contracts/output";
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

/**
 * The downloads a kids viewer sees: approved copies only, with sizes and ended counts that can't
 * hint at the rest. Household publications keep their owner; their jobs and progress are unchanged.
 */
export function visibleDownloads(list: DownloadList, allows: (approval: KidsApproval) => boolean) {
  const items = list.items.filter((item) => allows({ kind: "download", id: item.id }));

  return {
    ...list,
    items,
    series: Object.fromEntries(
      Object.entries(list.series).filter(([key]) => items.some((item) => item.series === key)),
    ),
    bytes: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
    ended: 0,
  };
}

/** A receiver as a kids viewer sees it: restricted media reads as nothing playing, with no failure text. */
export function visibleOutput(status: OutputStatus, allows: (approval: KidsApproval) => boolean) {
  const output = status.output;

  if (output.kind !== "receiver") return status;
  const item = output.media?.item;

  const allowed =
    !item ||
    (item.kind === "channel"
      ? allows({ kind: "channel", ...item.channel })
      : item.title.kind === "movie"
        ? allows(item.title)
        : allows({
            kind: "series",
            subscriptionId: item.title.subscriptionId,
            id: item.title.seriesId,
          }));

  return { ...status, output: { ...output, media: allowed ? output.media : null, failure: null } };
}
