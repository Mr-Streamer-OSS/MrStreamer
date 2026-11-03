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
  writeJson(name: string, value: unknown): void;
}) {
  const file = "library-versions.json";
  let raw: unknown;

  try {
    raw = storage.readJson(file);
  } catch {
    // An unreadable file is never an empty preference file.
  }

  // null also means an unreadable file in Android storage, so it cannot authorize a write.
  const valid = raw !== null && typeof raw === "object" && !Array.isArray(raw);

  let picks: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw))
      : {};

  return {
    get: (key: string) => (typeof picks[key] === "string" ? picks[key] : undefined),
    set(key: string, version: string | null) {
      if (!valid) throw new Error("Couldn't save version");
      const next = { ...picks };

      if (version === null) delete next[key];
      else next[key] = version;
      storage.writeJson(file, next);
      picks = next;
    },
  };
}
