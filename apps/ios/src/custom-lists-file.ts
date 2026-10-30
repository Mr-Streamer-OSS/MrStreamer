import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { type } from "arktype";
import { readJsonStrictly, removeJson, writeJson } from "./files.ts";

// The file of the viewer's channel lists (custom-lists.ts), apart from it so account.ts erases a
// subscription's channels from it without importing what reads the account. One JSON file in
// Documents, written whole before any screen shows a change: a write the folder refuses throws and
// changes nothing, the lists the screens show written back so a write cut short isn't read at the
// next launch. A file there that can't be read now, or that a later build wrote, shows no lists
// and is never written over, and a subscription's erasure waits on it (`eraseListMembers`); one
// that reads but isn't JSON holds none.

const FILE = "custom-lists.json";

const Saved = lazy(() =>
  type({
    version: "1",
    lists: type({
      id: "string",
      name: "string",
      revision: "number",
      members: type({
        member: "string",
        subscriptionId: "string",
        /** Every stream id it was seen with, the one it was found by when last listed first. */
        streams: "string[] > 0",
        /** What it was called when last listed. */
        name: "string",
      }).array(),
    }).array(),
  }),
);
export type StoredList = Infer<typeof Saved>["lists"][number];
export type StoredMember = StoredList["members"][number];

/**
 * The lists as the file holds them. `unreadable` is a file there that didn't read, `foreign` one
 * this build can't read, as a later build's.
 */
export type Kept =
  | { readonly kind: "read"; readonly lists: readonly StoredList[] }
  | { readonly kind: "unreadable" }
  | { readonly kind: "foreign" };

const UNREADABLE: Kept = { kind: "unreadable" };

function readKept(): Kept {
  let read: unknown;
  try {
    read = readJsonStrictly(FILE);
  } catch {
    return UNREADABLE;
  }
  if (read === null) return { kind: "read", lists: [] };
  const parsed = Saved()(read);
  return parsed instanceof type.errors
    ? { kind: "foreign" }
    : { kind: "read", lists: parsed.lists };
}

/** The file, read once, at the first look, then kept as written. */
let cached: Kept | null = null;
export const keptNow = () => (cached ??= readKept());
const listeners = new Set<() => void>();
/** For `useSyncExternalStore` with `keptNow`. */
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function keep(next: Kept) {
  cached = next;
  for (const listener of listeners) listener();
}

/** Reads the file again while it doesn't read, and shows its lists once it does. */
export function readAgain() {
  if (keptNow() !== UNREADABLE) return;
  const again = readKept();
  if (again !== UNREADABLE) keep(again);
}

/**
 * The lists as the file holds them, for a change. Throws, changing nothing, while the file doesn't
 * read, after reading it again, or holds lists this build can't read.
 */
export function stored(): readonly StoredList[] {
  readAgain();
  const from = keptNow();
  if (from.kind === "read") return from.lists;
  throw new AppFailure({
    kind: "unexpected",
    detail:
      from.kind === "foreign"
        ? "These lists were saved by a newer version of the app. Nothing was changed."
        : "Your lists couldn't be read. Nothing was changed.",
  });
}

/** Writes `lists` whole; only once the file took them do the screens show them. */
export function save(lists: readonly StoredList[]) {
  try {
    writeJson(FILE, { version: 1, lists });
  } catch (cause) {
    // A write cut short can leave the new lists under the temporary name, which a launch reads
    // when the file itself is gone.
    const shown = keptNow();
    try {
      if (shown.kind === "read") writeJson(FILE, { version: 1, lists: shown.lists });
    } catch {
      // With no lists before, nothing is lost with what that write left; with some, the disk
      // keeps what it took.
      if (shown.kind === "read" && shown.lists.length === 0) {
        try {
          removeJson(FILE);
        } catch {
          // As the disk left it.
        }
      }
    }
    throw cause;
  }
  keep({ kind: "read", lists });
}

/**
 * Deletes subscription `id`'s channels from every list, as account.ts erases its history. Throws,
 * so that erasure stays pending, as `stored` and `save` do.
 */
export function eraseListMembers(id: string): void {
  const lists = stored();
  if (!lists.some((list) => list.members.some((each) => each.subscriptionId === id))) return;
  save(
    lists.map((list) => ({
      ...list,
      members: list.members.filter((each) => each.subscriptionId !== id),
    })),
  );
}
