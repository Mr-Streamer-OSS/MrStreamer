import type { Json } from "@mrstreamer/contracts/json";
import type { Title, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";

/** A manual menu choice (including Automatic) wins, then an explicitly opened version, then saved. */
export function chosenVersion(
  title: Title,
  choices: {
    readonly manual?: string | null | undefined;
    readonly requested?: string | undefined;
    readonly remembered?: string | undefined;
  },
): TitleVersion {
  const listed = (key: string | undefined | null) =>
    title.versions.find((v) => ownedKey(v) === key);

  return (
    (choices.manual === null
      ? undefined
      : (listed(choices.manual) ?? listed(choices.requested) ?? listed(choices.remembered))) ??
    title.versions.find((v) => v.id === title.id && v.subscriptionId === title.subscriptionId) ??
    title.versions[0]!
  );
}

export function versionMemory(storage: {
  readJson(name: string): unknown;
  writeJson(name: string, value: Json): void;
}) {
  const file = "library-versions.json";
  let raw: unknown;

  try {
    raw = storage.readJson(file);
  } catch {
    // An unreadable file is never an empty preference file.
  }

  let picks: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw))
      : {};

  return {
    get: (key: string) => (typeof picks[key] === "string" ? picks[key] : undefined),
    set(key: string, version: string | null) {
      // Reread before saving: null starts again; an unreadable file remains retryable.
      const saved = storage.readJson(file);

      if (saved !== null && (typeof saved !== "object" || Array.isArray(saved)))
        throw new Error("Couldn't save version");
      const next: Record<string, unknown> = saved === null ? {} : { ...saved };

      if (version === null) delete next[key];
      else next[key] = version;
      storage.writeJson(file, next);
      picks = next;
    },
  };
}
