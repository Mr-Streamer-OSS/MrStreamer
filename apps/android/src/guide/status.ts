import { formatDate, t as sharedT } from "@mrstreamer/core/i18n";
import type { GuideProblem } from "./guide-native.ts";
import type { GuideStatus } from "./guide.ts";
import { t } from "./strings.ts";

const problems = {
  login: "The guide's server refused the link",
  http: "The guide's server answered with an error",
  network: "The guide's server didn't answer",
  redirect: "The link went somewhere this phone won't follow",
  xml: "That link isn't an XMLTV guide",
  gzip: "The compressed guide couldn't be opened",
  empty: "The guide has no programmes",
  ended: "The guide's programmes have all ended",
  body: "The guide is too large",
  element: "The guide has an entry too large to read",
  depth: "The guide's file is nested too deeply",
  rows: "The guide has too many programmes or channels",
  time: "The download took too long",
  disk: "There isn't enough space on this phone",
  reply: "The guide couldn't be read",
  unavailable: "The guide couldn't be read on this phone",
  busy: "The guide was busy. Try again.",
} as const satisfies Record<GuideProblem, Parameters<typeof t>[0]>;

/** Provider rows pass the same status as custom guides, with no editing affordance. */
export function statusLines(
  status: GuideStatus,
  locked = false,
): readonly { readonly text: string; readonly failed?: true }[] {
  const when = (at: number) => `${formatDate(at, "day")} ${formatDate(at, "time")}`;

  const kept =
    status.fetchedAt === null
      ? []
      : [{ text: t("Showing the guide from {time}", { time: when(status.fetchedAt) }) }];

  if (locked) return [{ text: t("Enter the link again"), failed: true }, ...kept];

  if (status.activity === "loading") return [{ text: sharedT("Downloading") }];

  if (status.error) return [{ text: t(problems[status.error]), failed: true }, ...kept];

  if (status.fetchedAt !== null)
    return [{ text: t("Updated {time}", { time: when(status.fetchedAt) }) }];

  return [{ text: sharedT("Not downloaded yet") }];
}
