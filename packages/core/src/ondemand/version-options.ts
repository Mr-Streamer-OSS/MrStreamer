// The version menu orders provider hints without opening files. Equal labels form a disclosure,
// never a replacement file: every distinct owned id remains an explicit choice inside it.
import type { TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { qualityHint } from "./filters.ts";
import { versionHint } from "./languages.ts";

const QUALITY_ORDER = ["4k", "full-hd", "hd", "sd", "unknown"] as const;
const QUALITY_LABEL = { "4k": "4K", "full-hd": "FHD", hd: "HD", sd: "SD", unknown: null };

export interface VersionOptionGroup {
  readonly key: string;
  readonly subscriptionId: string;
  readonly quality: string | null;
  readonly label: string;
  readonly asListed: boolean;
  readonly versions: readonly TitleVersion[];
}

/** Quality, named language, then saved provider order. Files keep their provider's list order. */
export function versionOptions(
  versions: readonly TitleVersion[],
  originalLanguage: string | null,
  providers: readonly string[],
): readonly VersionOptionGroup[] {
  const order = new Map(providers.map((id, index) => [id, index]));
  const groups = new Map<
    string,
    {
      group: Omit<VersionOptionGroup, "versions"> & { versions: TitleVersion[] };
      quality: number;
      language: number;
    }
  >();
  const seen = new Set<string>();
  for (const version of versions) {
    if (seen.has(ownedKey(version))) continue;
    seen.add(ownedKey(version));
    if (!order.has(version.subscriptionId)) order.set(version.subscriptionId, order.size);
    const quality = qualityHint(version.tags);
    const tags = version.tags.filter((tag) => qualityHint([tag]) === "unknown");
    const { label, named, asListed } = versionHint(tags, originalLanguage);
    const language = named ? 0 : tags.length === 0 ? 1 : 2;
    const key = JSON.stringify([version.subscriptionId, quality, label, asListed]);
    const held = groups.get(key);
    if (held) {
      held.group.versions.push(version);
      continue;
    }
    groups.set(key, {
      quality: QUALITY_ORDER.indexOf(quality),
      language,
      group: {
        key,
        subscriptionId: version.subscriptionId,
        quality: QUALITY_LABEL[quality],
        label,
        asListed,
        versions: [version],
      },
    });
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.quality - b.quality ||
        a.language - b.language ||
        (order.get(a.group.subscriptionId) ?? 0) - (order.get(b.group.subscriptionId) ?? 0),
    )
    .map(({ group }) => ({
      ...group,
      versions: group.versions.toSorted((a, b) => (a.listedOrder ?? 0) - (b.listedOrder ?? 0)),
    }));
}
